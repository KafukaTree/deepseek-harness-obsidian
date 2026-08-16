import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("active stylesheet contains only the right host, native tree and standalone workbench surfaces", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.dsh-right-panel-host/);
  assert.match(css, /\.dsh-session-badge/);
  assert.match(css, /\.dsh-agent-workbench/);
  assert.doesNotMatch(css, /\.dsh-companion|\.dsh-task-center/);
});

test("retired knowledge-object management CSS does not ship", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /\.dsh-object-manager|\.dsh-companion__context/);
  assert.ok(css.length < 11_000);
});

test("retired artifact capture modal CSS does not ship", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /\.dsh-artifact-capture/);
  assert.match(css, /textarea\.uV2eYG_input/);
  assert.match(css, /textarea\.uV2eYG_input\s*\{[\s\S]*?background-color:\s*transparent\s*!important/);
  assert.match(css, /textarea\.uV2eYG_input:focus\s*\{[\s\S]*?color:\s*var\(--dsw-alias-label-primary\)\s*!important/);
  assert.match(css, /textarea\.uV2eYG_input:focus\s*\{[\s\S]*?-webkit-text-fill-color:\s*var\(--dsw-alias-label-primary\)\s*!important/);
  assert.match(css, /caret-color:\s*var\(--dsw-alias-state-business-primary\)\s*!important/);
  assert.match(css, /"PingFang SC"/);
  assert.match(css, /\[role="menu"\][\s\S]*button\[role="menuitem"\]:has\(> span > span > span \+ span\)/);
  assert.match(css, /button\[role="menuitem"\][\s\S]*height:\s*auto\s*!important/);
  assert.doesNotMatch(css, /cubgiG_item|_itemDesc_/);
});
