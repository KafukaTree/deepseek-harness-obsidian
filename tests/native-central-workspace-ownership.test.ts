import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import test from "node:test";

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));

test("the active shell owns one official DSH host and one native AI workbench", async () => {
  const [main, root, workbench] = await Promise.all([
    readFile(join(pluginRoot, "src/main.ts"), "utf8"),
    readFile(join(pluginRoot, "src/companion/gui/embedded-root.ts"), "utf8"),
    readFile(join(pluginRoot, "src/companion/agent-workbench-view.ts"), "utf8")
  ]);

  const registrations = [...main.matchAll(/this\.registerView\(([^,]+),/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => value !== undefined);
  assert.deepEqual(registrations, [
    "DSH_MAIN_SESSION_VIEW_TYPE",
    "DSH_AGENT_WORKBENCH_VIEW_TYPE"
  ]);
  assert.doesNotMatch(
    main,
    /3099|3081|DshClient|CompanionView|TaskCenterView|ManagedSidecarSupervisor|ProposalStore|WritebackBackupStore/
  );
  assert.doesNotMatch(main, /querySelector\(|innerHTML\s*=/);
  assert.match(main, /settingsWriter\.save\(this\.settings\)/);
  assert.match(main, /createSession\(undefined, workspaceId \?\? undefined\)/);
  assert.match(main, /standaloneSessionGroups/);
  assert.match(main, /standaloneWorkspaceId/);

  assert.match(workbench, /data-action": "toggle-group"/);
  assert.match(workbench, /data-action": "new-session"/);
  assert.match(workbench, /data-action": "choose-workspace"/);
  assert.match(workbench, /openStandaloneSession/);
  assert.doesNotMatch(workbench, /iframe|sidebar\.(?:workspaces|sessions)/);

  assert.match(root, /renderSlot\("sidebar\.settings", \{ wide: true \}\)/);
  assert.match(root, /useSyncExternalStore/);
  assert.match(root, /dsh-embedded-settings-fallback/);
  assert.match(root, /!headerSettingsMounted/);
});

test("the published source tree contains only modules reachable from the active shell", async () => {
  const files = await typescriptFiles(join(pluginRoot, "src"));
  assert.deepEqual(files.map((path) => relative(pluginRoot, path)), [
    "src/companion/agent-workbench-view.ts",
    "src/companion/file-tree-bridge.ts",
    "src/companion/gui/embedded-root.ts",
    "src/companion/gui/gui-boot.ts",
    "src/companion/gui/transport.ts",
    "src/companion/main-instance-client.ts",
    "src/companion/main-instance-view.ts",
    "src/main.ts",
    "src/settings.ts",
    "src/state/serialized-snapshot-writer.ts",
    "src/state/session-map.ts",
    "src/state/standalone-session-map.ts",
    "src/state/workspace-scope.ts",
    "src/types/css.d.ts"
  ]);
});

test("official DSH settings and runtime controls ship without the retired global sidebar", async () => {
  const [gui, build, styles] = await Promise.all([
    readFile(join(pluginRoot, "src/companion/gui/gui-boot.ts"), "utf8"),
    readFile(join(pluginRoot, "esbuild.config.mjs"), "utf8"),
    readFile(join(pluginRoot, "styles.css"), "utf8")
  ]);
  const officialControls = [
    "dsh-client-ui-settings-general",
    "dsh-client-ui-settings-models",
    "dsh-client-ui-permission-presets",
    "dsh-client-ui-agent-preset",
    "dsh-client-ui-settings-plugins",
    "dsh-client-ui-settings-plugin-inventory",
    "dsh-client-ui-subagent",
    "dsh-client-ui-jobs"
  ];
  for (const id of officialControls) {
    assert.match(gui, new RegExp(`"@deepseek-ai/${id}"`));
    assert.match(build, new RegExp(`"@deepseek-ai/${id}"`));
  }
  assert.doesNotMatch(gui, /BUNDLED_PLUGIN_IDS[\s\S]{0,1600}"@deepseek-ai\/dsh-client-ui-sidebar"/);
  assert.doesNotMatch(build, /GUI_BUNDLE_IDS[\s\S]{0,1600}"@deepseek-ai\/dsh-client-ui-sidebar"/);
  assert.match(gui, /conversation\.session\.header\.utilities/);
  assert.match(gui, /"sidebar\.settings": \{ kind: "single", scope: "root" \}/);
  assert.match(styles, /container-type: inline-size/);
  assert.match(styles, /@container \(max-width: 720px\)/);
});

test("release metadata and installer are portable, data-safe and single-runtime", async () => {
  const [manifestText, packageText, readme, installer] = await Promise.all([
    readFile(join(pluginRoot, "manifest.json"), "utf8"),
    readFile(join(pluginRoot, "package.json"), "utf8"),
    readFile(join(pluginRoot, "README.md"), "utf8"),
    readFile(join(pluginRoot, "scripts/install-test-vault.mjs"), "utf8")
  ]);
  const manifest = JSON.parse(manifestText) as { version: string };
  const packageJson = JSON.parse(packageText) as {
    version: string;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.equal(manifest.version, "0.1.1");
  assert.equal(packageJson.version, manifest.version);
  assert.equal(
    Object.values({ ...packageJson.dependencies, ...packageJson.devDependencies })
      .some((version) => version.startsWith("file:")),
    false
  );
  assert.match(readme, /127\.0\.0\.1:3080/);
  assert.match(readme, /Windows/);
  assert.doesNotMatch(readme, /--profile (?:kb|obsidian)|127\.0\.0\.1:(?:3081|3099)/);
  assert.match(installer, /DSH_OBSIDIAN_TEST_VAULT/);
  assert.match(installer, /basename\(vaultRoot\).*=== "notes"/);
  assert.doesNotMatch(installer, /rm\(installRoot/);
  assert.doesNotMatch(installer, /data\.json/);
});

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && (path.endsWith(".ts") || path.endsWith(".d.ts"))
      ? [path]
      : [];
  }));
  return nested.flat().sort();
}
