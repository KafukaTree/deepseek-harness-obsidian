import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vaultRoot = resolve(
  process.env.DSH_OBSIDIAN_TEST_VAULT ??
    join(pluginRoot, ".sandbox", "obsidian-vault")
);

if (basename(vaultRoot).toLocaleLowerCase() === "notes") {
  throw new Error("Refusing to install a test build into a vault named Notes.");
}

const configRoot = join(vaultRoot, ".obsidian");
const installRoot = join(configRoot, "plugins", "deepseek-harness");

await mkdir(installRoot, { recursive: true });
await rm(join(installRoot, "plugins"), { recursive: true, force: true });
await Promise.all([
  cp(join(pluginRoot, "dist", "main.js"), join(installRoot, "main.js")),
  cp(join(pluginRoot, "dist", "manifest.json"), join(installRoot, "manifest.json")),
  cp(join(pluginRoot, "dist", "styles.css"), join(installRoot, "styles.css")),
  cp(join(pluginRoot, "dist", "versions.json"), join(installRoot, "versions.json")),
  cp(join(pluginRoot, "dist", "plugins"), join(installRoot, "plugins"), { recursive: true })
]);

const enabledPath = join(configRoot, "community-plugins.json");
const enabledPlugins = new Set(await readJsonArray(enabledPath));
enabledPlugins.add("deepseek-harness");
await writeFile(enabledPath, JSON.stringify([...enabledPlugins], null, 2));

const welcomePath = join(vaultRoot, "Welcome.md");
try {
  await readFile(welcomePath);
} catch (error) {
  if (!isMissing(error)) throw error;
  await writeFile(
    welcomePath,
    "# DeepSeek Harness test vault\n\nThis isolated vault is safe for plugin verification.\n"
  );
}

console.log(vaultRoot);

async function readJsonArray(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(parsed)
      ? parsed.filter((value) => typeof value === "string")
      : [];
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function isMissing(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
