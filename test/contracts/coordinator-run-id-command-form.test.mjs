// Issue 3224 AC4: a Claude Code Bash call drops an exported env var, and an env-prefixed
// command no longer matches the `Bash(dev-loops-run cli/index.mjs *)` allow rule. The lane's run
// id comes from the worktree run-context file instead, so the coordinator docs must name no
// env-prefixed or exported run id.
import assert from "node:assert/strict";
import { test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const COORDINATOR_DOCS = [
  "agents/dev-loop.agent.md",
  "agents/gate-coordinator.agent.md",
  "skills/dev-loop/SKILL.md",
  "skills/copilot-pr-followup/SKILL.md",
  "skills/docs/copilot-loop-operations.md",
  "skills/docs/merge-preconditions.md",
  "skills/docs/gate-review-sub-loop-contract.md",
];
const ENV_PREFIXED_RUN_ID = /\bDEVLOOPS_RUN_ID=[^\s`]/;
const EXPORTED_RUN_ID = /\bexport\s+DEVLOOPS_RUN_ID\b/;

test("coordinator docs name no env-prefixed or exported run id", () => {
  for (const rel of COORDINATOR_DOCS) {
    const text = fs.readFileSync(path.join(repoRoot, rel), "utf8");
    assert.doesNotMatch(text, ENV_PREFIXED_RUN_ID, `${rel} names an env-prefixed DEVLOOPS_RUN_ID`);
    assert.doesNotMatch(text, EXPORTED_RUN_ID, `${rel} exports DEVLOOPS_RUN_ID`);
  }
});

test("RUNNER-HANDOFF-TEARDOWN names the routed handoff form and the stale-claim recovery", () => {
  // The source names the routed `node <root>/cli/index.mjs` form; the Claude asset generator
  // renders it as `dev-loops-run cli/index.mjs ...`, which the allow rule matches.
  for (const [rel, prefix] of [
    ["skills/docs/copilot-loop-operations.md", "node <dev-loops-package-root>/cli/index.mjs"],
    [".claude/skills/docs/copilot-loop-operations.md", "dev-loops-run cli/index.mjs"],
  ]) {
    const text = fs.readFileSync(path.join(repoRoot, rel), "utf8");
    const rule = text.split("<!-- rule: RUNNER-HANDOFF-TEARDOWN -->")[1].split("\n\n")[0];
    assert.ok(rule.includes(`\`${prefix} loop runner-coordination handoff --repo <owner/name> --pr <number>\``), rel);
    assert.match(rule, /with no `--run-id`, no `DEVLOOPS_RUN_ID=` prefix and no `export`/, rel);
    assert.match(rule, /Stale-claim recovery: .*takeover --repo <owner\/name> --pr <number> --run-id/, rel);
  }
});
