import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SerializedSnapshotWriter } from "../src/state/serialized-snapshot-writer";

interface SettingsFixture {
  revision: number;
  sessionByPath: Record<string, string>;
  targetIdByPath: Record<string, string>;
}

test("settings snapshots are deep-cloned and written strictly in call order", async () => {
  let releaseFirst = () => {};
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let markFirstStarted = () => {};
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const writes: SettingsFixture[] = [];
  const writer = new SerializedSnapshotWriter<SettingsFixture>(async (snapshot) => {
    writes.push(snapshot);
    if (snapshot.revision === 1) {
      markFirstStarted();
      await firstGate;
    }
  });
  const live: SettingsFixture = {
    revision: 1,
    sessionByPath: { "Before.md": "session-before" },
    targetIdByPath: { "Before.md": "target-before" }
  };

  const first = writer.save(live);
  await firstStarted;
  live.revision = 2;
  live.sessionByPath = { "After.md": "session-after" };
  live.targetIdByPath["After.md"] = "target-after";
  const second = writer.save(live);
  live.revision = 3;
  live.sessionByPath["Later.md"] = "session-later";
  live.targetIdByPath["Later.md"] = "target-later";

  await Promise.resolve();
  assert.equal(writes.length, 1, "the second write must wait for the first adapter write");
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(writes, [
    {
      revision: 1,
      sessionByPath: { "Before.md": "session-before" },
      targetIdByPath: { "Before.md": "target-before" }
    },
    {
      revision: 2,
      sessionByPath: { "After.md": "session-after" },
      targetIdByPath: { "Before.md": "target-before", "After.md": "target-after" }
    }
  ]);
  assert.notEqual(writes[0]?.sessionByPath, live.sessionByPath);
  assert.notEqual(writes[1]?.targetIdByPath, live.targetIdByPath);
});

test("a failed settings write rejects its caller without poisoning the newer snapshot", async () => {
  const calls: number[] = [];
  const failure = new Error("synthetic adapter failure");
  const writer = new SerializedSnapshotWriter<SettingsFixture>(async (snapshot) => {
    calls.push(snapshot.revision);
    if (snapshot.revision === 1) throw failure;
  });
  const first = writer.save({ revision: 1, sessionByPath: {}, targetIdByPath: {} });
  const second = writer.save({
    revision: 2,
    sessionByPath: { "Recovered.md": "session-recovered" },
    targetIdByPath: {}
  });

  await assert.rejects(first, (error: unknown) => error === failure);
  await second;
  assert.deepEqual(calls, [1, 2]);
});

test("the plugin settings boundary uses the serialized writer instead of direct live-object saves", async () => {
  const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(main, /new SerializedSnapshotWriter<DeepSeekHarnessSettings>/);
  assert.match(main, /await this\.settingsWriter\.save\(this\.settings\)/);
  assert.doesNotMatch(main, /saveData\(this\.settings\)/);
});
