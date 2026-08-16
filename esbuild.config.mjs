import esbuild from "esbuild";
import builtins from "builtin-modules";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import process from "node:process";
import { officialWebStaticPlugin, readOfficialStaticCss } from "./scripts/official-web-static.mjs";

const production = process.argv[2] === "production";
const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  target: "es2022",
  loader: { ".css": "text" },
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  plugins: [officialWebStaticPlugin()],
  outfile: "dist/main.js"
});

async function copyStaticFiles() {
  await mkdir("dist", { recursive: true });
  await Promise.all([
    rm("dist/pdf.worker.min.mjs", { force: true }),
    rm("dist/standard_fonts", { recursive: true, force: true }),
    rm("dist/cmaps", { recursive: true, force: true }),
    rm("dist/plugins", { recursive: true, force: true })
  ]);
  await Promise.all([
    cp("manifest.json", "dist/manifest.json"),
    cp("LICENSE", "dist/LICENSE"),
    cp("THIRD_PARTY_NOTICES.md", "dist/THIRD_PARTY_NOTICES.md"),
    buildStyles(),
    cp("versions.json", "dist/versions.json"),
    ...copyGuiBundles()
  ]);
}

async function buildStyles() {
  const [pluginCss, officialStaticCss] = await Promise.all([
    readFile("styles.css", "utf8"),
    readOfficialStaticCss()
  ]);
  await writeFile("dist/styles.css", `${officialStaticCss}\n${pluginCss}`);
}

/** Official DSH client bundles, shipped next to the plugin for vm execution. */
const GUI_BUNDLE_IDS = [
  "@deepseek-ai/dsh-client-modules",
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-typert-registry",
  "@deepseek-ai/dsh-api-gateway",
  "@deepseek-ai/dsh-api-remotes",
  "@deepseek-ai/dsh-client-runtime",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-ui-theme",
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-settings-general",
  "@deepseek-ai/dsh-client-ui-settings-models",
  "@deepseek-ai/dsh-client-ui-conversation",
  "@deepseek-ai/dsh-client-ui-tool",
  "@deepseek-ai/dsh-client-ui-workspace",
  "@deepseek-ai/dsh-client-ui-input-trigger",
  "@deepseek-ai/dsh-client-ui-commands",
  "@deepseek-ai/dsh-client-ui-model-selection",
  "@deepseek-ai/dsh-client-ui-permission-presets",
  "@deepseek-ai/dsh-client-ui-agent-preset",
  "@deepseek-ai/dsh-client-ui-settings-plugins",
  "@deepseek-ai/dsh-client-ui-settings-plugin-inventory",
  "@deepseek-ai/dsh-client-ui-subagent",
  "@deepseek-ai/dsh-client-ui-jobs",
  "@deepseek-ai/dsh-client-ui-trajectory",
  "@deepseek-ai/dsh-client-ui-plan",
  "@deepseek-ai/dsh-client-ui-goal",
  "@deepseek-ai/dsh-client-ui-deliverables",
  "@deepseek-ai/dsh-session-log-export"
];

function copyGuiBundles() {
  return GUI_BUNDLE_IDS.map((id) => {
    const [, name] = id.split("/");
    return cp(
      `node_modules/${id}/lib/client.js`,
      `dist/plugins/${id}/client.js`
    );
  });
}

if (production) {
  await context.rebuild();
  await copyStaticFiles();
  await context.dispose();
} else {
  await copyStaticFiles();
  await context.watch();
}
