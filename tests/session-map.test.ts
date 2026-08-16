import assert from "node:assert/strict";
import test from "node:test";
import {
  addSessionBinding,
  bindKnowledgeSession,
  deterministicSessionId,
  movePathBindings,
  moveSessionBinding,
  normalizeSessionBindings,
  removePathBindings,
  removeSessionBindings,
  replaceSessionBinding
} from "../src/state/session-map";
import {
  addStandaloneSessionBinding,
  addStandaloneSessionGroup,
  DEFAULT_STANDALONE_GROUP_ID,
  normalizeStandaloneSessionBindings,
  selectStandaloneSessionBinding,
  standaloneSessionIds
} from "../src/state/standalone-session-map";

test("session id is stable per Vault and knowledge object", () => {
  const first = deterministicSessionId("/vault", "Folder/Note.md");
  assert.equal(first, deterministicSessionId("/vault", "Folder/Note.md"));
  assert.notEqual(first, deterministicSessionId("/other-vault", "Folder/Note.md"));
  assert.notEqual(first, deterministicSessionId("/vault", "Folder/Other.md"));
  assert.match(first, /^obsidian-[a-f0-9]{24}$/);
});

test("renaming a file preserves its DSH session", () => {
  const original = { "Old.md": "obsidian-session", "Keep.md": "keep" };
  const moved = moveSessionBinding(original, "Old.md", "Folder/New.md");
  assert.deepEqual(moved, { "Folder/New.md": "obsidian-session", "Keep.md": "keep" });
  assert.deepEqual(original, { "Old.md": "obsidian-session", "Keep.md": "keep" });
});

test("renaming a folder preserves bindings for the folder and descendants only", () => {
  const original = {
    "Old": "folder-session",
    "Old/A.md": "a-session",
    "Old/Nested/B.md": "b-session",
    "Oldish/Keep.md": "keep-session"
  };
  assert.deepEqual(moveSessionBinding(original, "Old", "New"), {
    "New": "folder-session",
    "New/A.md": "a-session",
    "New/Nested/B.md": "b-session",
    "Oldish/Keep.md": "keep-session"
  });
});

test("deleting a folder removes its descendant bindings without prefix collisions", () => {
  const original = {
    "Folder": "folder-session",
    "Folder/A.md": "a-session",
    "Folderish/B.md": "keep-session"
  };
  assert.deepEqual(removeSessionBindings(original, "Folder"), {
    "Folderish/B.md": "keep-session"
  });
  assert.equal(removeSessionBindings(original, "Missing"), original);
});

test("restoring or rebinding a session clears only related orphan records", () => {
  const bindings = { "Keep.md": "keep-session" };
  const orphans = {
    "Deleted.md": "session-a",
    "Another old path.md": "session-a",
    "Keep orphan.md": "keep-orphan"
  };
  const result = bindKnowledgeSession(bindings, orphans, "Deleted.md", "session-a");
  assert.deepEqual(result.sessionByPath, {
    "Keep.md": "keep-session",
    "Deleted.md": "session-a"
  });
  assert.deepEqual(result.orphanedSessions, { "Keep orphan.md": "keep-orphan" });
  assert.deepEqual(bindings, { "Keep.md": "keep-session" });
  assert.equal(result.changed, true);
});

test("binding is a no-op when the same clean relationship already exists", () => {
  const bindings = { "Note.md": "session-a" };
  const orphans = { "Other.md": "session-b" };
  const result = bindKnowledgeSession(bindings, orphans, "Note.md", "session-a");
  assert.equal(result.sessionByPath, bindings);
  assert.equal(result.orphanedSessions, orphans);
  assert.equal(result.changed, false);
});

test("one Obsidian target owns multiple Sessions and the newest becomes current", () => {
  const first = addSessionBinding({}, {}, "Research/Note.md", "session-a");
  const second = addSessionBinding(
    first.sessionsByPath,
    first.sessionByPath,
    "Research/Note.md",
    "session-b"
  );
  assert.deepEqual(second.sessionsByPath, {
    "Research/Note.md": ["session-a", "session-b"]
  });
  assert.equal(second.sessionByPath["Research/Note.md"], "session-b");
});

test("a blank legacy Session can be replaced in place without changing target order", () => {
  const replaced = replaceSessionBinding(
    { "Research": ["session-a", "legacy-blank", "session-c"] },
    { "Research": "legacy-blank" },
    "Research",
    "legacy-blank",
    "workspace-session"
  );
  assert.deepEqual(replaced.sessionsByPath, {
    "Research": ["session-a", "workspace-session", "session-c"]
  });
  assert.equal(replaced.sessionByPath.Research, "workspace-session");
});

test("legacy migration detaches every ambiguous path instead of guessing one owner", () => {
  const normalized = normalizeSessionBindings({}, {
    "Board.canvas": "shared-blank",
    "Boards": "shared-blank",
    "Unique.md": "unique"
  });
  assert.deepEqual(normalized.sessionsByPath, { "Unique.md": ["unique"] });
  assert.deepEqual(normalized.sessionByPath, { "Unique.md": "unique" });
  assert.deepEqual(normalized.conflictingSessionIds, ["shared-blank"]);
  assert.equal(normalized.conflictingPathCount, 2);
});

test("normalization deduplicates members and repairs a stale current selection", () => {
  const normalized = normalizeSessionBindings(
    { "Note.md": ["session-a", "session-a", "session-b", ""] },
    { "Note.md": "stale" }
  );
  assert.deepEqual(normalized.sessionsByPath, { "Note.md": ["session-a", "session-b"] });
  assert.equal(normalized.sessionByPath["Note.md"], "session-a");
});

test("folder lifecycle moves and removes membership arrays without sharing them", () => {
  const original = {
    Folder: ["folder-a", "folder-b"],
    "Folder/Note.md": ["note-a"],
    Folderish: ["keep"]
  };
  const moved = movePathBindings(original, "Folder", "Renamed");
  assert.deepEqual(moved, {
    Renamed: ["folder-a", "folder-b"],
    "Renamed/Note.md": ["note-a"],
    Folderish: ["keep"]
  });
  assert.deepEqual(removePathBindings(moved, "Renamed"), { Folderish: ["keep"] });
});

test("standalone workbench deduplicates members and repairs its current Session", () => {
  const normalized = normalizeStandaloneSessionBindings(
    [],
    ["standalone-a", "standalone-a", "standalone-b", ""],
    "missing"
  );
  assert.equal(normalized.groups[0]?.groupId, DEFAULT_STANDALONE_GROUP_ID);
  assert.deepEqual(standaloneSessionIds(normalized.groups), ["standalone-a", "standalone-b"]);
  assert.equal(normalized.activeSessionId, "standalone-a");
  assert.deepEqual(normalized.conflictingSessionIds, []);
});

test("content ownership excludes the same Session from the standalone workbench", () => {
  const normalized = normalizeStandaloneSessionBindings(
    [{
      groupId: "research",
      name: "研究",
      sessionIds: ["standalone-a", "content-session", "standalone-b"]
    }],
    [],
    "content-session",
    new Set(["content-session"])
  );
  assert.deepEqual(standaloneSessionIds(normalized.groups), ["standalone-a", "standalone-b"]);
  assert.equal(normalized.activeSessionId, "standalone-a");
  assert.deepEqual(normalized.conflictingSessionIds, ["content-session"]);
});

test("standalone folders append Sessions once and selection rejects an unowned Session", () => {
  const groups = addStandaloneSessionGroup([], "research", "研究");
  const first = addStandaloneSessionBinding(groups, "research", "standalone-a");
  const added = addStandaloneSessionBinding(first.groups, "research", "standalone-b");
  const duplicate = addStandaloneSessionBinding(added.groups, "research", "standalone-b");
  assert.deepEqual(standaloneSessionIds(duplicate.groups), ["standalone-a", "standalone-b"]);
  assert.equal(duplicate.activeSessionId, "standalone-b");
  assert.equal(
    selectStandaloneSessionBinding(duplicate.groups, duplicate.activeSessionId, "standalone-a"),
    "standalone-a"
  );
  assert.throws(
    () => selectStandaloneSessionBinding(duplicate.groups, "standalone-a", "foreign-session"),
    /cannot select unbound standalone session/
  );
  assert.throws(() => addStandaloneSessionGroup(groups, "another", "研究"), /name already exists/);
});
