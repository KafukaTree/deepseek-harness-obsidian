# DeepSeek Harness for Obsidian

An Obsidian desktop plugin that embeds the official DeepSeek Harness GUI while keeping Obsidian responsible for notes, folders, editing, themes, PDF and Canvas views.

## What it provides

- Native file explorer badges for one or more DSH Sessions attached to a note or folder.
- An Obsidian-style AI Workbench for standalone, grouped Sessions.
- A configurable default DSH Workspace for new standalone Sessions.
- The official DSH conversation, trajectory, subagent, Bash/tool, Session log, model, permission and settings components.
- A single local DSH WebGUI/runtime endpoint at `http://127.0.0.1:3080`.

The plugin does not start a second `kb` or `obsidian` profile and has no runtime dependency on ports 3081 or 3099.

## Requirements

- Obsidian Desktop 1.8 or newer.
- Node.js 20 or newer when building from source.
- DeepSeek Harness `0.1.0-rc.6` running locally on port 3080.

Start Harness before opening the plugin:

```bash
npx @deepseek-ai/dsh@0.1.0-rc.6 --port 3080
```

## Install a release

1. Download `deepseek-harness-obsidian-0.1.1.zip` from GitHub Releases.
2. Extract it into `<your-vault>/.obsidian/plugins/deepseek-harness/`.
3. Confirm that `main.js`, `manifest.json`, `styles.css` and the `plugins/` directory are directly inside that folder.
4. In Obsidian, open **Settings → Community plugins**, reload installed plugins if needed, then enable **DeepSeek Harness**.

The same package works on macOS and Windows. On Windows, a typical destination is:

```text
C:\Users\<you>\Documents\<vault>\.obsidian\plugins\deepseek-harness\
```

## Build from source

```bash
npm ci
npm run check
npm test
npm run build
```

Build output is written to `dist/`. To create the installable archive:

```bash
npm run release:zip
```

For an isolated development vault:

```bash
npm run install:test-vault
```

Set `DSH_OBSIDIAN_TEST_VAULT` to override the default `.sandbox/obsidian-vault` location. The installer refuses to target a vault named `Notes`.

## Architecture boundaries

- Obsidian owns the editor and filesystem UI.
- Official DSH packages own conversation and runtime controls; the plugin does not redraw simplified replacements.
- Content Sessions are keyed by Obsidian vault-relative paths. Renames preserve bindings and deletions remove only the affected path subtree.
- Standalone Workbench Sessions are separate from file/folder bindings.
- Plugin settings are serialized through one snapshot writer.
- The active shell uses only the main DSH instance on port 3080.

## License

[MIT](LICENSE)

The official DeepSeek Harness components and other bundled dependencies retain their respective MIT notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
