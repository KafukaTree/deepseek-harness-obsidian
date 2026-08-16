import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";

const STATIC_PACKAGE_PATTERN = /@deepseek-ai\/dsh-client-(?:ui-primitives|ui-attachment)\/lib\/index\.js$/;
let artifactsPromise;

/** Restore rc.6 CSS-module maps stripped from the standalone static packages. */
export function officialWebStaticPlugin() {
  return {
    name: "official-dsh-web-static",
    setup(build) {
      build.onLoad({ filter: STATIC_PACKAGE_PATTERN }, async ({ path }) => {
        const [source, artifacts] = await Promise.all([
          readFile(path, "utf8"),
          loadArtifacts()
        ]);
        return {
          contents: patchCssModuleStubs(source, artifacts.webJavaScript, artifacts.webCss),
          loader: "js",
          resolveDir: dirname(path)
        };
      });
    }
  };
}

/** Exact official rules whose hashed classes were restored by the plugin. */
export async function readOfficialStaticCss() {
  const artifacts = await loadArtifacts();
  const classes = new Set();
  for (const sourcePath of artifacts.staticPackagePaths) {
    const source = await readFile(sourcePath, "utf8");
    const mappings = resolveStubMappings(source, artifacts.webJavaScript, artifacts.webCss);
    for (const mapping of mappings.values()) {
      for (const className of Object.values(mapping)) classes.add(className);
    }
  }
  return filterOfficialCss(artifacts.webCss, classes);
}

async function loadArtifacts() {
  artifactsPromise ??= (async () => {
    const frontendPackage = fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-web-frontend/package.json"));
    const assetsRoot = join(dirname(frontendPackage), "dist", "assets");
    const assets = await readdir(assetsRoot);
    const javaScriptName = oneAsset(assets, /^index-.*\.js$/);
    const cssName = oneAsset(assets, /^index-.*\.css$/);
    const staticPackagePaths = [
      fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-client-ui-primitives")),
      fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-client-ui-attachment"))
    ];
    const [webJavaScript, webCss] = await Promise.all([
      readFile(join(assetsRoot, javaScriptName), "utf8"),
      readFile(join(assetsRoot, cssName), "utf8")
    ]);
    return { webJavaScript, webCss, staticPackagePaths };
  })();
  return artifactsPromise;
}

function oneAsset(names, pattern) {
  const matches = names.filter((name) => pattern.test(name));
  if (matches.length !== 1) {
    throw new Error(`official web static: expected one ${pattern}, found ${matches.length}`);
  }
  return matches[0];
}

function patchCssModuleStubs(source, webJavaScript, webCss) {
  const mappings = resolveStubMappings(source, webJavaScript, webCss);
  let patched = source;
  for (const [variable, mapping] of mappings) {
    patched = patched.replace(
      `var ${variable} = {};`,
      `var ${variable} = ${JSON.stringify(mapping)};`
    );
  }
  if (/var [\w$]+_module_css_default = \{\};/.test(patched)) {
    throw new Error("official web static: one or more CSS-module stubs were not restored");
  }
  return patched;
}

function resolveStubMappings(source, webJavaScript, webCss) {
  const stubs = collectStubs(source);
  const candidates = collectWebMappings(webJavaScript, webCss);
  const resolved = new Map();
  let cursor = -1;
  for (const stub of stubs) {
    const candidate = candidates.find((item) => item.index > cursor && sameKeys(item.mapping, stub.keys));
    if (candidate === undefined) {
      throw new Error(`official web static: no ordered mapping for ${stub.variable} (${[...stub.keys].join(", ")})`);
    }
    cursor = candidate.index;
    resolved.set(stub.variable, candidate.mapping);
  }
  return resolved;
}

function collectStubs(source) {
  const matches = [...source.matchAll(/var ([\w$]+_module_css_default) = \{\};/g)];
  return matches.map((match) => {
    const variable = match[1];
    const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const keys = new Set();
    for (const use of source.matchAll(new RegExp(`\\b${escaped}\\.([A-Za-z_$][\\w$]*)`, "g"))) {
      if (use[1] !== undefined) keys.add(use[1]);
    }
    for (const use of source.matchAll(new RegExp(`\\b${escaped}\\[\"([^\"]+)\"\\]`, "g"))) {
      if (use[1] !== undefined) keys.add(use[1]);
    }
    if (keys.size === 0) throw new Error(`official web static: ${variable} has no consumed classes`);
    return { variable, keys };
  });
}

function collectWebMappings(webJavaScript, webCss) {
  const stringValues = new Map();
  for (const match of webJavaScript.matchAll(/([A-Za-z_$][\w$]*)="(_[^"]+)"/g)) {
    if (match[1] !== undefined && match[2] !== undefined) stringValues.set(match[1], match[2]);
  }

  const candidates = [];
  for (const match of webJavaScript.matchAll(/[A-Za-z_$][\w$]*=\{([^{}]{1,5000})}/g)) {
    const body = match[1] ?? "";
    const mapping = {};
    let parsed = 0;
    for (const entry of body.matchAll(/(?:^|,)(?:"([^"]+)"|([A-Za-z_$][\w$]*)):([A-Za-z_$][\w$]*)/g)) {
      parsed += 1;
      const key = entry[1] ?? entry[2];
      const value = entry[3] === undefined ? undefined : stringValues.get(entry[3]);
      if (key !== undefined && value !== undefined) mapping[key] = value;
    }
    if (parsed === 0 || Object.keys(mapping).length !== parsed) continue;
    if (!Object.values(mapping).every((className) => webCss.includes(`.${className}`))) continue;
    candidates.push({ index: match.index ?? 0, mapping });
  }
  return candidates;
}

function sameKeys(mapping, keys) {
  const mapped = Object.keys(mapping);
  const mappingContainsUses = [...keys].every((key) => Object.hasOwn(mapping, key));
  const usesContainMapping = mapped.every((key) => keys.has(key));
  return mappingContainsUses || usesContainMapping;
}

function filterOfficialCss(css, classes) {
  const root = postcss.parse(css);
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes$/i.test(rule.parent.name)) return;
    const ownsOfficialClass = [...classes].some((className) => rule.selector.includes(`.${className}`));
    if (!ownsOfficialClass) {
      rule.remove();
      return;
    }
    // The host declares button:not(.clickable-icon), which is more specific
    // than many official one-class selectors. Add only a body ancestor: the
    // declarations, states and tokens remain byte-for-byte official rc.6.
    rule.selectors = rule.selectors.map((selector) => scopeToDocument(selector));
  });
  root.walkAtRules((atRule) => {
    if (/keyframes$/i.test(atRule.name)) return;
    if (atRule.name === "font-face" || atRule.nodes?.length === 0) atRule.remove();
  });
  return `/* Official rc.6 static-component CSS, extracted from dsh-web-frontend. */\n${root.toString()}\n`;
}

function scopeToDocument(selector) {
  const trimmed = selector.trim();
  return /^(?:body|html|:root)(?:\b|\[|\.|#|:)/.test(trimmed)
    ? trimmed
    : `body ${trimmed}`;
}
