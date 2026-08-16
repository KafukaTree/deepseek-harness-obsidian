import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { targetWorkspacePath } from "../src/state/workspace-scope";

const vaultRoot = resolve("test-vault");

test("a folder badge creates or selects that exact folder file workspace", () => {
  assert.equal(
    targetWorkspacePath(vaultRoot, "A-Tasks", "folder"),
    join(vaultRoot, "A-Tasks")
  );
  assert.equal(
    targetWorkspacePath(vaultRoot, "INFO/knowledge", "folder"),
    join(vaultRoot, "INFO", "knowledge")
  );
});

test("a file badge selects its parent folder workspace", () => {
  assert.equal(
    targetWorkspacePath(vaultRoot, "A-Tasks/计划.md", "file"),
    join(vaultRoot, "A-Tasks")
  );
  assert.equal(
    targetWorkspacePath(vaultRoot, "首页.md", "file"),
    vaultRoot
  );
});
