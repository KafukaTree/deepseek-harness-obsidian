import assert from "node:assert/strict";
import test from "node:test";
import { targetWorkspacePath } from "../src/state/workspace-scope";

test("a folder badge creates or selects that exact folder file workspace", () => {
  assert.equal(
    targetWorkspacePath("/Users/example/Notes", "A-Tasks", "folder"),
    "/Users/example/Notes/A-Tasks"
  );
  assert.equal(
    targetWorkspacePath("/Users/example/Notes", "INFO/knowledge", "folder"),
    "/Users/example/Notes/INFO/knowledge"
  );
});

test("a file badge selects its parent folder workspace", () => {
  assert.equal(
    targetWorkspacePath("/Users/example/Notes", "A-Tasks/计划.md", "file"),
    "/Users/example/Notes/A-Tasks"
  );
  assert.equal(
    targetWorkspacePath("/Users/example/Notes", "首页.md", "file"),
    "/Users/example/Notes"
  );
});
