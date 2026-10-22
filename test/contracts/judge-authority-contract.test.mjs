// The judge owns every disposition, the verdict and the next action. The persona
// and its generated copy state the cluster rules and the template-section reject
// on every spec source.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

for (const file of ["agents/judge.agent.md", ".claude/agents/judge.md"]) {
  test(`${file} rejects template-only findings on every spec source and disposes by cluster`, async () => {
    const text = (await readFile(`${repoRoot}${file}`, "utf8")).replace(/\s+/g, " ");
    assert.match(text, /On every spec source, a finding whose only claim is that a section the repo's PR template does not define .{0,160} is absent is `reject`/);
    assert.match(text, /`index` is the cluster's `clusterId`/);
    assert.match(text, /`title`, `detail` and `fix` are required on every disposition and `reason` on `defer` and `reject`/);
    assert.match(text, /No code path defers or rejects a finding from severity or round alone/);
    assert.match(text, /Fan-in leaves every finding `unjudged`/);
  });
}
