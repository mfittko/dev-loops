import assert from "node:assert/strict";
import test from "node:test";

import { decideBashGate, decideWriteGuard } from "../src/claude/hook-decisions.mjs";

const TARGET = "mfittko/dev-loops";

// ---------------------------------------------------------------------------
// decideBashGate
// ---------------------------------------------------------------------------

test("decideBashGate allows non-gh-pr-ready commands", () => {
  assert.equal(decideBashGate({ command: "npm test", repoSlug: TARGET }).decision, "allow");
  assert.equal(decideBashGate({ command: "gh pr merge 1 --squash", repoSlug: TARGET }).decision, "allow");
});

test("decideBashGate denies ungated gh pr ready in the target repo", () => {
  const d = decideBashGate({ command: "gh pr ready 17", repoSlug: TARGET, gatePassed: false });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /no visible clean draft_gate/);
  assert.match(d.reason, /#17/);
});

test("decideBashGate allows gh pr ready when the draft gate passed", () => {
  assert.equal(decideBashGate({ command: "gh pr ready 17", repoSlug: TARGET, gatePassed: true }).decision, "allow");
});

test("decideBashGate passes through when not in the target repo", () => {
  assert.equal(decideBashGate({ command: "gh pr ready 17", repoSlug: "someone/else", gatePassed: false }).decision, "allow");
  assert.equal(decideBashGate({ command: "gh pr ready 17", repoSlug: null, gatePassed: false }).decision, "allow");
});

test("decideBashGate passes through an explicit non-target --repo", () => {
  assert.equal(
    decideBashGate({ command: "gh pr ready --repo other/repo 1", repoSlug: TARGET, gatePassed: false }).decision,
    "allow",
  );
});

test("decideBashGate denies when PR number cannot be determined", () => {
  const d = decideBashGate({ command: "gh pr ready", repoSlug: TARGET, gatePassed: false });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /could not determine the PR number/);
});

test("decideBashGate denies with a guard-failure reason when the gate could not run", () => {
  const d = decideBashGate({ command: "gh pr ready 5", repoSlug: TARGET, gateError: "could not run the draft-gate guard script" });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /draft-gate evidence check failed/);
});

// ---------------------------------------------------------------------------
// decideWriteGuard
// ---------------------------------------------------------------------------

test("decideWriteGuard fails open when enforcement is disabled", () => {
  assert.equal(
    decideWriteGuard({ filePath: "packages/core/src/x.mjs", isRepoMutation: true, enforce: false, env: {} }).decision,
    "allow",
  );
});

test("decideWriteGuard denies a main-agent repo mutation under strict enforcement", () => {
  const d = decideWriteGuard({ filePath: "packages/core/src/x.mjs", isRepoMutation: true, enforce: true, env: {} });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /Main-agent read-only boundary/);
  assert.match(d.reason, /x\.mjs/);
});

test("decideWriteGuard allows non-repo / gitignored paths even under enforcement", () => {
  assert.equal(
    decideWriteGuard({ filePath: "/tmp/note.md", isRepoMutation: false, enforce: true, env: {} }).decision,
    "allow",
  );
});

test("decideWriteGuard allows the dev-loop subagent context via the CA2 run id", () => {
  assert.equal(
    decideWriteGuard({ filePath: "src/x.mjs", isRepoMutation: true, enforce: true, env: { DEVLOOPS_RUN_ID: "devloops-1" } }).decision,
    "allow",
  );
  // Pi alias is honored by resolveRunId too.
  assert.equal(
    decideWriteGuard({ filePath: "src/x.mjs", isRepoMutation: true, enforce: true, env: { DEVLOOPS_RUN_ID: "run-1" } }).decision,
    "allow",
  );
});

test("decideWriteGuard allows the dev-loop subagent via agent_type", () => {
  assert.equal(
    decideWriteGuard({ filePath: "src/x.mjs", isRepoMutation: true, enforce: true, env: {}, agentType: "dev-loop" }).decision,
    "allow",
  );
});

test("decideWriteGuard denies a generic (non-dev-loop) subagent — no bypass via arbitrary agents", () => {
  for (const agentType of ["Explore", "Plan", "general-purpose", "developer"]) {
    const d = decideWriteGuard({ filePath: "src/x.mjs", isRepoMutation: true, enforce: true, env: {}, agentType });
    assert.equal(d.decision, "deny", `agent_type ${agentType} must not bypass the boundary`);
  }
});
