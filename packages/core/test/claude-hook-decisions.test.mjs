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

// #1172: PreToolUse blocks pre-execution, so a compound write+merge command never runs the write —
// the ledger looks like it "vanished". Hint the split when the command also writes gate evidence.
test("decideBashGate hints the write/merge split when the compound command also writes gate evidence", () => {
  const d = decideBashGate({
    command: "node scripts/loop/write-gate-findings-log.mjs --pr 1 && gh pr merge 1 --squash",
    repoSlug: TARGET,
    gatePassed: false,
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /gh pr merge blocked/);
  assert.match(d.reason, /hooks evaluate before the command runs/);

  const d2 = decideBashGate({
    command: "node scripts/github/upsert-checkpoint-verdict.mjs --pr 1 && gh pr merge 1",
    repoSlug: TARGET,
    gatePassed: false,
  });
  assert.equal(d2.decision, "deny");
  assert.match(d2.reason, /hooks evaluate before the command runs/);
});

test("decideBashGate keeps the standard message for a bare gh pr merge (no evidence write)", () => {
  const d = decideBashGate({ command: "gh pr merge 1 --squash", repoSlug: TARGET, gatePassed: false });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /gh pr merge blocked/);
  assert.doesNotMatch(d.reason, /hooks evaluate before the command runs/);
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
  // From any cwd, an explicit non-target repo stays out of our concern.
  assert.equal(
    decideBashGate({ command: "gh pr create --repo other/repo --fill", repoSlug: null }).decision,
    "allow",
  );
});

test("decideBashGate denies gh pr create --repo targeting the repo regardless of cwd (#1047)", () => {
  // Explicit --repo at the target still opens a ready PR bypassing the draft-first wrapper,
  // even run from outside the repo (repoSlug null or a non-target repo).
  const outside = decideBashGate({ command: `gh pr create --repo ${TARGET} --fill`, repoSlug: null });
  assert.equal(outside.decision, "deny");
  assert.match(outside.reason, /gh pr create blocked/);
  assert.equal(
    decideBashGate({ command: `gh pr create --repo ${TARGET} --fill`, repoSlug: "someone/else" }).decision,
    "deny",
  );
});

test("decideBashGate evaluates each gh pr create segment's scope (multi-create bypass)", () => {
  // The bypass: a leading out-of-scope create must not shield a later in-scope raw create.
  const bypass = decideBashGate({ command: "gh pr create --repo other/repo && gh pr create --fill", repoSlug: TARGET });
  assert.equal(bypass.decision, "deny");
  assert.match(bypass.reason, /gh pr create blocked/);
  // Reverse order — the in-scope create leads — also denies.
  assert.equal(
    decideBashGate({ command: "gh pr create --fill && gh pr create --repo other/repo", repoSlug: TARGET }).decision,
    "deny",
  );
  // Every create segment carries an explicit non-target --repo → none in scope even when
  // cwd is the target, so this passes through (locks the per-segment semantics).
  assert.equal(
    decideBashGate({ command: "gh pr create --repo other/repo && gh pr create --repo another/repo", repoSlug: TARGET }).decision,
    "allow",
  );
});

// --- subagent-scoped external-write guard (#1051) ---

const SUB = "dev-loop"; // any non-null agent_type = subagent context

test("decideBashGate denies raw gh issue create from a subagent on the target repo", () => {
  const d = decideBashGate({ command: "gh issue create --title x --body y", repoSlug: TARGET, agentType: SUB });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /Ad-hoc GitHub issue\/PR creation/);
});

test("decideBashGate ALLOWS raw gh issue create from the MAIN agent (agentType null) — AC3", () => {
  assert.equal(decideBashGate({ command: "gh issue create --title x --body y", repoSlug: TARGET }).decision, "allow");
  assert.equal(
    decideBashGate({ command: "gh issue create --title x", repoSlug: TARGET, agentType: null }).decision,
    "allow",
  );
});

test("decideBashGate denies raw gh issue/pr comment from a subagent on the target repo", () => {
  assert.equal(
    decideBashGate({ command: "gh issue comment 5 --body hi", repoSlug: TARGET, agentType: SUB }).decision,
    "deny",
  );
  assert.equal(
    decideBashGate({ command: "gh pr comment 5 --body hi", repoSlug: TARGET, agentType: SUB }).decision,
    "deny",
  );
});

test("decideBashGate denies raw gh issue edit from a subagent on the target repo", () => {
  assert.equal(
    decideBashGate({ command: "gh issue edit 5 --body-file x", repoSlug: TARGET, agentType: SUB }).decision,
    "deny",
  );
});

test("decideBashGate ALLOWS raw gh issue edit from the MAIN agent (agentType null)", () => {
  assert.equal(
    decideBashGate({ command: "gh issue edit 5 --body-file x", repoSlug: TARGET, agentType: null }).decision,
    "allow",
  );
});

test("decideBashGate allows subagent gh issue edit with an explicit non-target --repo", () => {
  assert.equal(
    decideBashGate({ command: "gh issue edit 5 --repo other/repo --body-file x", repoSlug: TARGET, agentType: SUB }).decision,
    "allow",
  );
});

test("decideBashGate allows subagent gh issue create with an explicit non-target --repo", () => {
  assert.equal(
    decideBashGate({ command: "gh issue create --repo other/repo --title x", repoSlug: TARGET, agentType: SUB }).decision,
    "allow",
  );
});

test("decideBashGate denies subagent gh issue create --repo targeting the repo regardless of cwd", () => {
  assert.equal(
    decideBashGate({ command: `gh issue create --repo ${TARGET} --title x`, repoSlug: null, agentType: SUB }).decision,
    "deny",
  );
  assert.equal(
    decideBashGate({ command: `gh issue create --repo ${TARGET} --title x`, repoSlug: "someone/else", agentType: SUB }).decision,
    "deny",
  );
});

test("decideBashGate denies subagent gh issue create redirected via inline GH_REPO= to the target (#1074)", () => {
  // GH_REPO= (no --repo flag) targets the repo → the off-cwd redirect hole is closed.
  assert.equal(
    decideBashGate({ command: `GH_REPO=${TARGET} gh issue create --title x`, repoSlug: "someone/else", agentType: SUB }).decision,
    "deny",
  );
  assert.equal(
    decideBashGate({ command: `GH_REPO=${TARGET} gh issue create --title x`, repoSlug: null, agentType: SUB }).decision,
    "deny",
  );
  // quoted GH_REPO value is normalized before the scope compare.
  assert.equal(
    decideBashGate({ command: `GH_REPO='${TARGET}' gh issue create --title x`, repoSlug: "someone/else", agentType: SUB }).decision,
    "deny",
  );
});

test("decideBashGate: explicit --repo wins over GH_REPO; non-target GH_REPO passes through (#1074)", () => {
  // flag precedence: --repo other/repo overrides GH_REPO=target → off-target → allow.
  assert.equal(
    decideBashGate({ command: `GH_REPO=${TARGET} gh issue create --repo other/repo --title x`, repoSlug: "someone/else", agentType: SUB }).decision,
    "allow",
  );
  // GH_REPO=non-target from a non-target cwd → off-target → allow.
  assert.equal(
    decideBashGate({ command: "GH_REPO=other/repo gh issue create --title x", repoSlug: "someone/else", agentType: SUB }).decision,
    "allow",
  );
});

test("decideBashGate allows the comment-issue.mjs wrapper even from a subagent", () => {
  assert.equal(
    decideBashGate({ command: "node scripts/github/comment-issue.mjs 5 --body hi", repoSlug: TARGET, agentType: SUB }).decision,
    "allow",
  );
  assert.equal(
    decideBashGate({ command: "node scripts/github/upsert-checkpoint-verdict.mjs --pr 5", repoSlug: TARGET, agentType: SUB }).decision,
    "allow",
  );
});

test("decideBashGate denies subagent external write hidden behind compound/newline/env bypasses", () => {
  assert.equal(
    decideBashGate({ command: "git push && gh issue create --title x", repoSlug: TARGET, agentType: SUB }).decision,
    "deny",
  );
  assert.equal(
    decideBashGate({ command: "echo hi\ngh issue create --title x", repoSlug: TARGET, agentType: SUB }).decision,
    "deny",
  );
  assert.equal(
    decideBashGate({ command: "GH_TOKEN=x gh issue comment 5 --body hi", repoSlug: TARGET, agentType: SUB }).decision,
    "deny",
  );
});

test("decideBashGate passes through subagent external write off-target / no target --repo", () => {
  assert.equal(
    decideBashGate({ command: "gh issue create --title x", repoSlug: "someone/else", agentType: SUB }).decision,
    "allow",
  );
  assert.equal(
    decideBashGate({ command: "gh issue create --title x", repoSlug: null, agentType: SUB }).decision,
    "allow",
  );
});

test("decideBashGate does not let a leading out-of-scope external write shield a later in-scope one", () => {
  assert.equal(
    decideBashGate({ command: "gh issue create --repo other/repo && gh issue comment 5 --body hi", repoSlug: TARGET, agentType: SUB }).decision,
    "deny",
  );
});

test("decideBashGate treats an EMPTY-STRING agent_type as subagent context (non-null) — denies on target (#1074)", () => {
  assert.equal(
    decideBashGate({ command: "gh issue create --title x --body y", repoSlug: TARGET, agentType: "" }).decision,
    "deny",
  );
});

test("decideBashGate denies subagent gh issue create with a QUOTED target --repo (#1074)", () => {
  assert.equal(
    decideBashGate({ command: `gh issue create --repo '${TARGET}' --title x`, repoSlug: null, agentType: SUB }).decision,
    "deny",
  );
  assert.equal(
    decideBashGate({ command: `gh issue create --repo "${TARGET}" --title x`, repoSlug: null, agentType: SUB }).decision,
    "deny",
  );
});

test("decideBashGate denies gh pr create with a QUOTED target --repo (#1074)", () => {
  assert.equal(
    decideBashGate({ command: `gh pr create --repo '${TARGET}' --fill`, repoSlug: null }).decision,
    "deny",
  );
});

test("decideBashGate does not let an out-of-scope gh pr create short-circuit ready/merge gating", () => {
  // An out-of-scope `--repo other/repo` create must not own the decision when a gated
  // ready/merge segment rides along in the same compound command — the merge/ready segment
  // is still gated below (no evidence → deny).
  assert.equal(
    decideBashGate({
      command: "gh pr create --repo other/repo && gh pr merge 5",
      repoSlug: TARGET,
      gatePassed: false,
    }).decision,
    "deny",
  );
  assert.equal(
    decideBashGate({
      command: "gh pr create --repo other/repo && gh pr ready 5",
      repoSlug: TARGET,
      gatePassed: false,
    }).decision,
    "deny",
  );
  // A pure out-of-scope create alone still passes through.
  assert.equal(
    decideBashGate({ command: "gh pr create --repo other/repo", repoSlug: TARGET }).decision,
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
