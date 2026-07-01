import assert from "node:assert/strict";
import test from "node:test";

import { decideBashGate, decideWriteGuard } from "../src/claude/hook-decisions.mjs";

const TARGET = "mfittko/dev-loops";

// ---------------------------------------------------------------------------
// decideBashGate
// ---------------------------------------------------------------------------

test("decideBashGate allows non-gated commands", () => {
  assert.equal(decideBashGate({ command: "npm test", repoSlug: TARGET }).decision, "allow");
  assert.equal(decideBashGate({ command: "gh pr view 1", repoSlug: TARGET }).decision, "allow");
});

test("decideBashGate denies ungated gh pr ready in the target repo", () => {
  const d = decideBashGate({ command: "gh pr ready 17", repoSlug: TARGET, gatePassed: false });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /no visible clean draft_gate/);
  assert.match(d.reason, /#17/);
});

// gh pr merge is gated on the full pre-merge evidence (draft_gate + pre_approval_gate); a direct
// merge must not bypass the pre-approval gate the way a hand-run `gh pr merge` previously could.
test("decideBashGate denies ungated gh pr merge in the target repo", () => {
  const d = decideBashGate({ command: "gh pr merge 1 --squash", repoSlug: TARGET, gatePassed: false });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /gh pr merge blocked/);
  assert.match(d.reason, /pre_approval_gate/);
  assert.match(d.reason, /#1/);
});

test("decideBashGate allows gh pr merge when pre-merge evidence passed", () => {
  assert.equal(
    decideBashGate({ command: "gh pr merge 1 --squash", repoSlug: TARGET, gatePassed: true }).decision,
    "allow",
  );
});

test("decideBashGate passes through gh pr merge for a non-target --repo", () => {
  assert.equal(
    decideBashGate({ command: "gh pr merge --repo other/repo 1", repoSlug: TARGET, gatePassed: false }).decision,
    "allow",
  );
});

test("decideBashGate passes through gh pr merge outside the target repo", () => {
  assert.equal(
    decideBashGate({ command: "gh pr merge 1 --squash", repoSlug: "someone/else", gatePassed: false }).decision,
    "allow",
  );
});

// Copilot review findings: compound command bypasses must be blocked.
test("decideBashGate denies gh pr merge in a later compound segment", () => {
  const d = decideBashGate({ command: "echo ok && gh pr merge 1 --squash", repoSlug: TARGET, gatePassed: false });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /gh pr merge blocked/);
});

test("decideBashGate applies the stricter merge gate when both ready and merge appear", () => {
  // gh pr ready && gh pr merge — merge gate (stricter) must be applied, not just draft_gate.
  const d = decideBashGate({ command: "gh pr ready 1 && gh pr merge 1", repoSlug: TARGET, gatePassed: false });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /gh pr merge blocked/);
  assert.match(d.reason, /pre_approval_gate/);
});

test("decideBashGate denies gh pr merge when PR number cannot be determined", () => {
  const d = decideBashGate({ command: "gh pr merge --squash", repoSlug: TARGET, gatePassed: false });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /could not determine the PR number/);
});

test("decideBashGate denies with a pre-merge gate error reason for gh pr merge", () => {
  const d = decideBashGate({ command: "gh pr merge 42", repoSlug: TARGET, gateError: "could not run the gate guard script" });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /pre-merge gate evidence check failed/);
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

test("decideBashGate denies raw gh pr create in the target repo", () => {
  const d = decideBashGate({ command: "gh pr create --title x --body y", repoSlug: TARGET });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /gh pr create blocked/);
  assert.match(d.reason, /create-pr\.mjs/);
});

test("decideBashGate denies raw gh pr create --draft too (wrapper is the only path)", () => {
  // Even an explicit --draft must route through the wrapper (it also self-assigns).
  const d = decideBashGate({ command: "gh pr create --draft --fill", repoSlug: TARGET });
  assert.equal(d.decision, "deny");
});

test("decideBashGate denies gh pr create in a later compound segment", () => {
  const d = decideBashGate({ command: "git push && gh pr create --fill", repoSlug: TARGET });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /gh pr create blocked/);
});

test("decideBashGate denies gh pr create hidden behind newline/env/wrapper/path bypasses", () => {
  assert.equal(decideBashGate({ command: "echo hi\ngh pr create --fill", repoSlug: TARGET }).decision, "deny");
  assert.equal(decideBashGate({ command: "GH_TOKEN=x gh pr create --fill", repoSlug: TARGET }).decision, "deny");
  assert.equal(decideBashGate({ command: "command gh pr create", repoSlug: TARGET }).decision, "deny");
  assert.equal(decideBashGate({ command: "/usr/bin/gh pr create", repoSlug: TARGET }).decision, "deny");
  // shared root cause: ready reached via a newline is also gated
  assert.equal(decideBashGate({ command: "echo hi\ngh pr ready 5", repoSlug: TARGET, gatePassed: false }).decision, "deny");
});

test("decideBashGate allows the create-pr.mjs wrapper (not a raw gh pr create)", () => {
  assert.equal(
    decideBashGate({ command: "node scripts/github/create-pr.mjs --title x --fill", repoSlug: TARGET }).decision,
    "allow",
  );
  // wrapper still passes through even with a leading env assignment
  assert.equal(
    decideBashGate({ command: "GH_TOKEN=x node scripts/github/create-pr.mjs --fill", repoSlug: TARGET }).decision,
    "allow",
  );
});

test("decideBashGate passes through gh pr create outside the target repo", () => {
  assert.equal(decideBashGate({ command: "gh pr create --fill", repoSlug: "someone/else" }).decision, "allow");
  assert.equal(decideBashGate({ command: "gh pr create --fill", repoSlug: null }).decision, "allow");
});

test("decideBashGate passes through gh pr create with an explicit non-target --repo", () => {
  assert.equal(
    decideBashGate({ command: "gh pr create --repo other/repo --fill", repoSlug: TARGET }).decision,
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
