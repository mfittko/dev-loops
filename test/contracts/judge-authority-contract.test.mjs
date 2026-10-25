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
    assert.match(text, /A section that `\.github\/pull_request_template\.md` defines .{0,100} is never covered by this rule/);
    assert.match(text, /`index` is the cluster's `clusterId`/);
    assert.match(text, /`title`, `detail` and `fix` are required on every disposition and `reason` on `defer` and `reject`/);
    assert.match(text, /No code path defers or rejects a finding from severity or round alone/);
    assert.match(text, /a cluster that contains a `high` or a `question`, and an all-`nit` cluster, is never deferred/);
  });
}

// The documented emit path supplies the round the judge needs for the medium fix window.
test("the documented emit-judge-work-order invocations carry --round", async () => {
  for (const file of ["skills/docs/gate-review-sub-loop-contract.md", "skills/copilot-pr-followup/SKILL.md", ".claude/skills/docs/gate-review-sub-loop-contract.md", ".claude/skills/copilot-pr-followup/SKILL.md"]) {
    const text = await readFile(`${repoRoot}${file}`, "utf8");
    assert.match(text, /--round <n>/, file);
  }
  assert.match(await readFile(`${repoRoot}scripts/loop/emit-judge-work-order.mjs`, "utf8"), /\[--round <n>\] \[--tmp-root/);
});
