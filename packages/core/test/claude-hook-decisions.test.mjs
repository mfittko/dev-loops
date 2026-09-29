import assert from "node:assert/strict";
import { test } from "bun:test";

import { decideBashGate, decideJudgeWriteGuard, decideWriteGuard, decideCoordinatorWriteGuard, decideSubagentStopGuard, decideWorktreeCheckoutGuard, WORKTREE_CHECKOUT_GUARD_OVERRIDE_ENV, normalizeAgentType, decideFixerWriteGuard, decideAgentDispatch } from "../src/claude/hook-decisions.mjs";
import { buildDispatchPointer } from "../../../scripts/github/_work-order-protocol.mjs";

const TARGET = "mfittko/dev-loops";

// ---------------------------------------------------------------------------
// decideBashGate
// ---------------------------------------------------------------------------

test("decideBashGate allows non-gated commands", () => {
  assert.equal(decideBashGate({ command: "npm test", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET }).decision, "allow");
  assert.equal(decideBashGate({ command: "gh pr view 1", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET }).decision, "allow");
});

test("decideBashGate denies git stash on the target repo (refs/stash is shared across worktrees)", () => {
  const d = decideBashGate({ command: "git stash", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /git stash blocked/);
  assert.match(d.reason, /refs\/stash is shared/);
});

test("decideBashGate allows git stash off the target repo", () => {
  assert.equal(decideBashGate({ command: "git stash pop", repoSlug: "someone/else", inManagedContext: true, managedRepoSlug: TARGET }).decision, "allow");
  assert.equal(decideBashGate({ command: "git stash pop", repoSlug: null, inManagedContext: true, managedRepoSlug: TARGET }).decision, "allow");
});

test("decideBashGate denies git stash behind env-assignment/wrapper/path/git-option prefixes", () => {
  assert.equal(decideBashGate({ command: "GIT_DIR=.git git stash", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET }).decision, "deny");
  assert.equal(decideBashGate({ command: "command git stash", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET }).decision, "deny");
  assert.equal(decideBashGate({ command: "/usr/bin/git stash", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET }).decision, "deny");
  assert.equal(decideBashGate({ command: "git -C /tmp stash", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET }).decision, "deny");
  assert.equal(decideBashGate({ command: "git -c foo=bar stash pop", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET }).decision, "deny");
});

test("decideBashGate denies ungated gh pr ready in the target repo", () => {
  const d = decideBashGate({ command: "gh pr ready 17", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, gatePassed: false });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /no visible clean draft_gate/);
  assert.match(d.reason, /#17/);
});

// Raw `gh pr merge` is forbidden outright — only the wrapper is sanctioned. A direct
// merge must never bypass the wrapper's mandatory approver / merge-class / fresh-approval checks.
test("decideBashGate denies a raw gh pr merge in the target repo", () => {
  const d = decideBashGate({ command: "gh pr merge 1 --squash", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, gatePassed: false });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /gh pr merge is forbidden/);
  assert.match(d.reason, /--pr 1\b/);
});

// issue #1939: raw `gh pr merge` is forbidden — the interception deny directs the caller to the
// sanctioned wrapper so a flagged raw merge names its replacement.
test("decideBashGate deny for a raw merge points to the merge-pr.mjs wrapper", () => {
  const d = decideBashGate({ command: "gh pr merge 1 --squash", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, gatePassed: false });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /scripts\/github\/merge-pr\.mjs/);
  assert.match(d.reason, /--human-approved-by/);
});

// #1172: PreToolUse blocks pre-execution, so a compound write+merge command never runs the write —
// the ledger looks like it "vanished". Hint the split when the command also writes gate evidence.
test("decideBashGate hints the write/merge split when the compound command also writes gate evidence", () => {
  const d = decideBashGate({
    command: "node scripts/loop/write-gate-findings-log.mjs --pr 1 && gh pr merge 1 --squash",
    repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET,
    gatePassed: false,
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /gh pr merge is forbidden/);
  assert.match(d.reason, /hooks evaluate before the command runs/);

  const d2 = decideBashGate({
    command: "node scripts/github/upsert-checkpoint-verdict.mjs --pr 1 && gh pr merge 1",
    repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET,
    gatePassed: false,
  });
  assert.equal(d2.decision, "deny");
  assert.match(d2.reason, /hooks evaluate before the command runs/);
});

test("decideBashGate keeps the standard message for a bare gh pr merge (no evidence write)", () => {
  const d = decideBashGate({ command: "gh pr merge 1 --squash", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, gatePassed: false });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /gh pr merge is forbidden/);
  assert.doesNotMatch(d.reason, /hooks evaluate before the command runs/);
});

test("decideBashGate denies a raw gh pr merge even when pre-merge evidence passed (forbidden outright)", () => {
  const d = decideBashGate({ command: "gh pr merge 1 --squash", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, gatePassed: true });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /gh pr merge is forbidden/);
  assert.match(d.reason, /merge-pr\.mjs/);
});

test("decideBashGate passes through gh pr merge for a non-target --repo", () => {
  assert.equal(
    decideBashGate({ command: "gh pr merge --repo other/repo 1", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, gatePassed: false }).decision,
    "allow",
  );
});

test("decideBashGate passes through gh pr merge outside the target repo", () => {
  assert.equal(
    decideBashGate({ command: "gh pr merge 1 --squash", repoSlug: "someone/else", inManagedContext: true, managedRepoSlug: TARGET, gatePassed: false }).decision,
    "allow",
  );
});

// Copilot review findings: compound command bypasses must be blocked.
test("decideBashGate denies gh pr merge in a later compound segment", () => {
  const d = decideBashGate({ command: "echo ok && gh pr merge 1 --squash", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, gatePassed: false });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /gh pr merge is forbidden/);
});

test("decideBashGate applies the stricter merge gate when both ready and merge appear", () => {
  // gh pr ready && gh pr merge — the merge verb (forbidden outright) is the stricter deny.
  const d = decideBashGate({ command: "gh pr ready 1 && gh pr merge 1", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, gatePassed: false });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /gh pr merge is forbidden/);
});

test("decideBashGate denies gh pr merge when PR number cannot be determined", () => {
  const d = decideBashGate({ command: "gh pr merge --squash", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, gatePassed: false });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /could not determine the PR number/);
});

test("decideBashGate denies a raw gh pr merge and still surfaces a gate error", () => {
  const d = decideBashGate({ command: "gh pr merge 42", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, gateError: "could not run the gate guard script" });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /gh pr merge is forbidden/);
  assert.match(d.reason, /gate evidence check also failed/);
});

test("decideBashGate allows gh pr ready when the draft gate passed", () => {
  assert.equal(decideBashGate({ command: "gh pr ready 17", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, gatePassed: true }).decision, "allow");
});

test("decideBashGate passes through when not in the target repo", () => {
  assert.equal(decideBashGate({ command: "gh pr ready 17", repoSlug: "someone/else", inManagedContext: true, managedRepoSlug: TARGET, gatePassed: false }).decision, "allow");
  assert.equal(decideBashGate({ command: "gh pr ready 17", repoSlug: null, inManagedContext: true, managedRepoSlug: TARGET, gatePassed: false }).decision, "allow");
});

test("decideBashGate passes through an explicit non-target --repo", () => {
  assert.equal(
    decideBashGate({ command: "gh pr ready --repo other/repo 1", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, gatePassed: false }).decision,
    "allow",
  );
});

// --- per-segment scoping: a proven-foreign leading segment must not shield a later managed
// gh pr merge/ready segment (#2193) ---

test("decideBashGate denies a later managed gh pr merge segment behind a proven-foreign leading one", () => {
  const d = decideBashGate({
    command: "gh pr merge --repo other/x 1 && gh pr merge 2",
    repoSlug: TARGET,
    inManagedContext: true,
    managedRepoSlug: TARGET,
    gatePassed: false,
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /gh pr merge is forbidden/);
});

test("decideBashGate denies a later managed gh pr ready segment behind a proven-foreign leading one", () => {
  const d = decideBashGate({
    command: "gh pr ready --repo other/x 1 && gh pr ready 2",
    repoSlug: TARGET,
    inManagedContext: true,
    managedRepoSlug: TARGET,
    gatePassed: false,
  });
  assert.equal(d.decision, "deny");
});

test("decideBashGate passes through when every gh pr merge segment is proven foreign", () => {
  assert.equal(
    decideBashGate({
      command: "gh pr merge --repo other/x 1 && gh pr merge --repo other/y 2",
      repoSlug: TARGET,
      inManagedContext: true,
      managedRepoSlug: TARGET,
      gatePassed: false,
    }).decision,
    "allow",
  );
});

test("decideBashGate fails closed when the managed slug is unresolvable and a segment lacks an explicit repo", () => {
  // A foreign-looking first segment must not shield a later managed one when the managed slug
  // can't be resolved — that segment can't be proven foreign, so the whole command stays gated.
  const d = decideBashGate({
    command: "gh pr merge --repo other/x 1 && gh pr merge 2",
    repoSlug: null,
    inManagedContext: true,
    managedRepoSlug: null,
    gatePassed: false,
  });
  assert.equal(d.decision, "deny");
});

// --- standalone `&` (async/background operator) must also be a segment boundary, closing the
// same shielding gap the `&&` tests above cover (Copilot review follow-up, #2193) ---

test("decideBashGate denies a later managed gh pr merge segment behind a proven-foreign leading one joined by &", () => {
  const d = decideBashGate({
    command: "gh pr merge --repo other/x 1 & gh pr merge 2",
    repoSlug: TARGET,
    inManagedContext: true,
    managedRepoSlug: TARGET,
    gatePassed: false,
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /gh pr merge is forbidden/);
});

test("decideBashGate denies a later managed gh pr ready segment behind a proven-foreign leading one joined by &", () => {
  const d = decideBashGate({
    command: "gh pr ready --repo other/x 1 & gh pr ready 2",
    repoSlug: TARGET,
    inManagedContext: true,
    managedRepoSlug: TARGET,
    gatePassed: false,
  });
  assert.equal(d.decision, "deny");
});

test("decideBashGate passes through when every &-joined gh pr merge segment is proven foreign", () => {
  assert.equal(
    decideBashGate({
      command: "gh pr merge --repo other/x 1 & gh pr merge --repo other/y 2",
      repoSlug: TARGET,
      inManagedContext: true,
      managedRepoSlug: TARGET,
      gatePassed: false,
    }).decision,
    "allow",
  );
});

test("decideBashGate denies raw gh pr create in the target repo", () => {
  const d = decideBashGate({ command: "gh pr create --title x --body y", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /gh pr create blocked/);
  assert.match(d.reason, /create-pr\.mjs/);
});

test("decideBashGate denies raw gh pr create --draft too (wrapper is the only path)", () => {
  // Even an explicit --draft must route through the wrapper (it also self-assigns).
  const d = decideBashGate({ command: "gh pr create --draft --fill", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET });
  assert.equal(d.decision, "deny");
});

test("decideBashGate denies gh pr create in a later compound segment", () => {
  const d = decideBashGate({ command: "git push && gh pr create --fill", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /gh pr create blocked/);
});

test("decideBashGate denies gh pr create hidden behind newline/env/wrapper/path bypasses", () => {
  assert.equal(decideBashGate({ command: "echo hi\ngh pr create --fill", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET }).decision, "deny");
  assert.equal(decideBashGate({ command: "GH_TOKEN=x gh pr create --fill", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET }).decision, "deny");
  assert.equal(decideBashGate({ command: "command gh pr create", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET }).decision, "deny");
  assert.equal(decideBashGate({ command: "/usr/bin/gh pr create", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET }).decision, "deny");
  // shared root cause: ready reached via a newline is also gated
  assert.equal(decideBashGate({ command: "echo hi\ngh pr ready 5", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, gatePassed: false }).decision, "deny");
});

test("decideBashGate allows the create-pr.mjs wrapper (not a raw gh pr create)", () => {
  assert.equal(
    decideBashGate({ command: "node scripts/github/create-pr.mjs --title x --fill", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET }).decision,
    "allow",
  );
  // wrapper still passes through even with a leading env assignment
  assert.equal(
    decideBashGate({ command: "GH_TOKEN=x node scripts/github/create-pr.mjs --fill", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET }).decision,
    "allow",
  );
});

test("decideBashGate passes through gh pr create outside the target repo", () => {
  assert.equal(decideBashGate({ command: "gh pr create --fill", repoSlug: "someone/else", inManagedContext: true, managedRepoSlug: TARGET }).decision, "allow");
  assert.equal(decideBashGate({ command: "gh pr create --fill", repoSlug: null, inManagedContext: true, managedRepoSlug: TARGET }).decision, "allow");
});

test("decideBashGate passes through gh pr create with an explicit non-target --repo", () => {
  assert.equal(
    decideBashGate({ command: "gh pr create --repo other/repo --fill", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET }).decision,
    "allow",
  );
  // From any cwd, an explicit non-target repo stays out of our concern.
  assert.equal(
    decideBashGate({ command: "gh pr create --repo other/repo --fill", repoSlug: null, inManagedContext: true, managedRepoSlug: TARGET }).decision,
    "allow",
  );
});

test("decideBashGate denies gh pr create --repo targeting the repo regardless of cwd (#1047)", () => {
  // Explicit --repo at the target still opens a ready PR bypassing the draft-first wrapper,
  // even run from outside the repo (repoSlug null or a non-target repo).
  const outside = decideBashGate({ command: `gh pr create --repo ${TARGET} --fill`, repoSlug: null, inManagedContext: true, managedRepoSlug: TARGET });
  assert.equal(outside.decision, "deny");
  assert.match(outside.reason, /gh pr create blocked/);
  assert.equal(
    decideBashGate({ command: `gh pr create --repo ${TARGET} --fill`, repoSlug: "someone/else", inManagedContext: true, managedRepoSlug: TARGET }).decision,
    "deny",
  );
});

test("decideBashGate evaluates each gh pr create segment's scope (multi-create bypass)", () => {
  // The bypass: a leading out-of-scope create must not shield a later in-scope raw create.
  const bypass = decideBashGate({ command: "gh pr create --repo other/repo && gh pr create --fill", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET });
  assert.equal(bypass.decision, "deny");
  assert.match(bypass.reason, /gh pr create blocked/);
  // Reverse order — the in-scope create leads — also denies.
  assert.equal(
    decideBashGate({ command: "gh pr create --fill && gh pr create --repo other/repo", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET }).decision,
    "deny",
  );
  // Every create segment carries an explicit non-target --repo → none in scope even when
  // cwd is the target, so this passes through (locks the per-segment semantics).
  assert.equal(
    decideBashGate({ command: "gh pr create --repo other/repo && gh pr create --repo another/repo", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET }).decision,
    "allow",
  );
});

// --- subagent-scoped external-write guard (#1051) ---

const SUB = "dev-loop"; // any non-null agent_type = subagent context

test("decideBashGate denies raw gh issue create from a subagent on the target repo", () => {
  const d = decideBashGate({ command: "gh issue create --title x --body y", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: SUB });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /Ad-hoc GitHub issue\/PR creation/);
});

test("decideBashGate ALLOWS raw gh issue create from the MAIN agent (agentType null) — AC3", () => {
  assert.equal(decideBashGate({ command: "gh issue create --title x --body y", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET }).decision, "allow");
  assert.equal(
    decideBashGate({ command: "gh issue create --title x", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: null }).decision,
    "allow",
  );
});

test("decideBashGate denies raw gh issue/pr comment from a subagent on the target repo", () => {
  assert.equal(
    decideBashGate({ command: "gh issue comment 5 --body hi", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: SUB }).decision,
    "deny",
  );
  assert.equal(
    decideBashGate({ command: "gh pr comment 5 --body hi", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: SUB }).decision,
    "deny",
  );
});

test("decideBashGate denies raw gh issue edit from a subagent on the target repo", () => {
  assert.equal(
    decideBashGate({ command: "gh issue edit 5 --body-file x", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: SUB }).decision,
    "deny",
  );
});

test("decideBashGate ALLOWS raw gh issue edit from the MAIN agent (agentType null)", () => {
  assert.equal(
    decideBashGate({ command: "gh issue edit 5 --body-file x", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: null }).decision,
    "allow",
  );
});

test("decideBashGate allows subagent gh issue edit with an explicit non-target --repo", () => {
  assert.equal(
    decideBashGate({ command: "gh issue edit 5 --repo other/repo --body-file x", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: SUB }).decision,
    "allow",
  );
});

test("decideBashGate allows subagent gh issue create with an explicit non-target --repo", () => {
  assert.equal(
    decideBashGate({ command: "gh issue create --repo other/repo --title x", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: SUB }).decision,
    "allow",
  );
});

test("decideBashGate denies subagent gh issue create --repo targeting the repo regardless of cwd", () => {
  assert.equal(
    decideBashGate({ command: `gh issue create --repo ${TARGET} --title x`, repoSlug: null, inManagedContext: true, managedRepoSlug: TARGET, agentType: SUB }).decision,
    "deny",
  );
  assert.equal(
    decideBashGate({ command: `gh issue create --repo ${TARGET} --title x`, repoSlug: "someone/else", inManagedContext: true, managedRepoSlug: TARGET, agentType: SUB }).decision,
    "deny",
  );
});

test("decideBashGate denies subagent gh issue create redirected via inline GH_REPO= to the target (#1074)", () => {
  // GH_REPO= (no --repo flag) targets the repo → the off-cwd redirect hole is closed.
  assert.equal(
    decideBashGate({ command: `GH_REPO=${TARGET} gh issue create --title x`, repoSlug: "someone/else", inManagedContext: true, managedRepoSlug: TARGET, agentType: SUB }).decision,
    "deny",
  );
  assert.equal(
    decideBashGate({ command: `GH_REPO=${TARGET} gh issue create --title x`, repoSlug: null, inManagedContext: true, managedRepoSlug: TARGET, agentType: SUB }).decision,
    "deny",
  );
  // quoted GH_REPO value is normalized before the scope compare.
  assert.equal(
    decideBashGate({ command: `GH_REPO='${TARGET}' gh issue create --title x`, repoSlug: "someone/else", inManagedContext: true, managedRepoSlug: TARGET, agentType: SUB }).decision,
    "deny",
  );
});

test("decideBashGate: explicit --repo wins over GH_REPO; non-target GH_REPO passes through (#1074)", () => {
  // flag precedence: --repo other/repo overrides GH_REPO=target → off-target → allow.
  assert.equal(
    decideBashGate({ command: `GH_REPO=${TARGET} gh issue create --repo other/repo --title x`, repoSlug: "someone/else", inManagedContext: true, managedRepoSlug: TARGET, agentType: SUB }).decision,
    "allow",
  );
  // GH_REPO=non-target from a non-target cwd → off-target → allow.
  assert.equal(
    decideBashGate({ command: "GH_REPO=other/repo gh issue create --title x", repoSlug: "someone/else", inManagedContext: true, managedRepoSlug: TARGET, agentType: SUB }).decision,
    "allow",
  );
});

test("decideBashGate allows the comment-issue.mjs wrapper even from a subagent", () => {
  assert.equal(
    decideBashGate({ command: "node scripts/github/comment-issue.mjs 5 --body hi", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: SUB }).decision,
    "allow",
  );
  assert.equal(
    decideBashGate({ command: "node scripts/github/upsert-checkpoint-verdict.mjs --pr 5", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: SUB }).decision,
    "allow",
  );
});

test("decideBashGate denies subagent external write hidden behind compound/newline/env bypasses", () => {
  assert.equal(
    decideBashGate({ command: "git push && gh issue create --title x", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: SUB }).decision,
    "deny",
  );
  assert.equal(
    decideBashGate({ command: "echo hi\ngh issue create --title x", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: SUB }).decision,
    "deny",
  );
  assert.equal(
    decideBashGate({ command: "GH_TOKEN=x gh issue comment 5 --body hi", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: SUB }).decision,
    "deny",
  );
});

test("decideBashGate passes through subagent external write off-target / no target --repo", () => {
  assert.equal(
    decideBashGate({ command: "gh issue create --title x", repoSlug: "someone/else", inManagedContext: true, managedRepoSlug: TARGET, agentType: SUB }).decision,
    "allow",
  );
  assert.equal(
    decideBashGate({ command: "gh issue create --title x", repoSlug: null, inManagedContext: true, managedRepoSlug: TARGET, agentType: SUB }).decision,
    "allow",
  );
});

test("decideBashGate does not let a leading out-of-scope external write shield a later in-scope one", () => {
  assert.equal(
    decideBashGate({ command: "gh issue create --repo other/repo && gh issue comment 5 --body hi", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: SUB }).decision,
    "deny",
  );
});

test("decideBashGate treats an EMPTY-STRING agent_type as subagent context (non-null) — denies on target (#1074)", () => {
  assert.equal(
    decideBashGate({ command: "gh issue create --title x --body y", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: "" }).decision,
    "deny",
  );
});

test("decideBashGate denies subagent gh issue create with a QUOTED target --repo (#1074)", () => {
  assert.equal(
    decideBashGate({ command: `gh issue create --repo '${TARGET}' --title x`, repoSlug: null, inManagedContext: true, managedRepoSlug: TARGET, agentType: SUB }).decision,
    "deny",
  );
  assert.equal(
    decideBashGate({ command: `gh issue create --repo "${TARGET}" --title x`, repoSlug: null, inManagedContext: true, managedRepoSlug: TARGET, agentType: SUB }).decision,
    "deny",
  );
});

test("decideBashGate denies gh pr create with a QUOTED target --repo (#1074)", () => {
  assert.equal(
    decideBashGate({ command: `gh pr create --repo '${TARGET}' --fill`, repoSlug: null, inManagedContext: true, managedRepoSlug: TARGET }).decision,
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
      repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET,
      gatePassed: false,
    }).decision,
    "deny",
  );
  assert.equal(
    decideBashGate({
      command: "gh pr create --repo other/repo && gh pr ready 5",
      repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET,
      gatePassed: false,
    }).decision,
    "deny",
  );
  // A pure out-of-scope create alone still passes through.
  assert.equal(
    decideBashGate({ command: "gh pr create --repo other/repo", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET }).decision,
    "allow",
  );
});

test("decideBashGate denies when PR number cannot be determined", () => {
  const d = decideBashGate({ command: "gh pr ready", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, gatePassed: false });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /could not determine the PR number/);
});

test("decideBashGate denies with a guard-failure reason when the gate could not run", () => {
  const d = decideBashGate({ command: "gh pr ready 5", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, gateError: "could not run the draft-gate guard script" });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /draft-gate evidence check failed/);
});

// ---------------------------------------------------------------------------
// decideBashGate — COORDINATOR-VERIFY-BOUNDARY (#2082): a coordinator verify-command
// delegation boundary gated by the SAME DEVLOOPS_COORDINATOR_READONLY flag as
// decideCoordinatorWriteGuard. Pi no-op rationale: Pi never invokes the Claude PreToolUse Bash
// gate hook (nor sets its `agent_type` payload field), so this branch — and the flag that gates
// it — is inert there; no cross-harness regression per #1086.
// ---------------------------------------------------------------------------

test("decideBashGate DENIES a coordinator running a code-verification entrypoint under strict coordinator enforcement", () => {
  const d = decideBashGate({
    command: "bun run verify",
    repoSlug: TARGET,
    inManagedContext: true,
    managedRepoSlug: TARGET,
    agentType: "dev-loop",
    enforceCoordinator: true,
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /COORDINATOR-VERIFY-BOUNDARY/);
  assert.match(d.reason, /targeted checks.*worker subagent/);
  assert.match(d.reason, /full-repository validation.*dev-loops gate resolve-validation/);
  assert.match(d.reason, /main-agent-contract\.md/);
});

test("decideBashGate's verify-boundary deny for a gate coordinator names its own path, not a worker dispatch", () => {
  for (const agentType of ["gate-coordinator", "dev-loops:gate-coordinator"]) {
    const d = decideBashGate({ command: "bun run verify", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType, enforceCoordinator: true });
    assert.equal(d.decision, "deny");
    assert.match(d.reason, /COORDINATOR-VERIFY-BOUNDARY/);
    assert.match(d.reason, /resolve-validation/);
    assert.match(d.reason, /typed observation/);
    assert.doesNotMatch(d.reason, /worker subagent/);
  }
});

test("decideBashGate ALLOWS a worker subagent running a code-verification entrypoint under strict coordinator enforcement", () => {
  const d = decideBashGate({
    command: "bun run verify",
    repoSlug: TARGET,
    inManagedContext: true,
    managedRepoSlug: TARGET,
    agentType: "developer",
    enforceCoordinator: true,
  });
  assert.equal(d.decision, "allow");
});

test("decideBashGate ALLOWS a coordinator running a compact orchestration command under strict coordinator enforcement", () => {
  for (const command of ["dev-loops queue list", "git status --short"]) {
    const d = decideBashGate({
      command,
      repoSlug: TARGET,
      inManagedContext: true,
      managedRepoSlug: TARGET,
      agentType: "dev-loop",
      enforceCoordinator: true,
    });
    assert.equal(d.decision, "allow", `compact command "${command}" must not be denied`);
  }
});

test("decideBashGate DENIES a namespaced dev-loops:dev-loop coordinator running a code-verification entrypoint under strict coordinator enforcement (#2082 pre-PR review)", () => {
  const d = decideBashGate({
    command: "bun run verify",
    repoSlug: TARGET,
    inManagedContext: true,
    managedRepoSlug: TARGET,
    agentType: "dev-loops:dev-loop",
    enforceCoordinator: true,
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /COORDINATOR-VERIFY-BOUNDARY/);
});

test("decideBashGate ALLOWS a namespaced dev-loops:developer worker running a code-verification entrypoint under strict coordinator enforcement (#2082 pre-PR review)", () => {
  const d = decideBashGate({
    command: "bun run verify",
    repoSlug: TARGET,
    inManagedContext: true,
    managedRepoSlug: TARGET,
    agentType: "dev-loops:developer",
    enforceCoordinator: true,
  });
  assert.equal(d.decision, "allow");
});

test("decideBashGate ALLOWS a coordinator running a code-verification entrypoint when DEVLOOPS_COORDINATOR_READONLY is unset (fail-open)", () => {
  const d = decideBashGate({
    command: "bun run verify",
    repoSlug: TARGET,
    inManagedContext: true,
    managedRepoSlug: TARGET,
    agentType: "dev-loop",
    // enforceCoordinator omitted — defaults to false (fail-open)
  });
  assert.equal(d.decision, "allow");
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

// ---------------------------------------------------------------------------
// decideCoordinatorWriteGuard (#2082) — coordinator→worker delegation boundary.
// The INVERSE of decideWriteGuard, one level down: the dev-loop COORDINATOR (agent_type
// "dev-loop") must not mutate tracked repo files directly; WORKER subagents (developer/fixer/
// quality/docs) may. Pi no-op rationale: this decider — and the DEVLOOPS_COORDINATOR_READONLY
// flag that gates it — only fires when agent_type === "dev-loop" under the Claude write-guard
// hook; Pi never sets Claude's `agent_type` payload field and does not invoke this hook, so the
// boundary is inert there (no cross-harness regression per #1086).
// ---------------------------------------------------------------------------

test("decideCoordinatorWriteGuard fails open when enforcement is disabled", () => {
  assert.equal(
    decideCoordinatorWriteGuard({ filePath: "packages/core/src/x.mjs", isRepoMutation: true, enforce: false, agentType: "dev-loop" }).decision,
    "allow",
  );
});

test("decideCoordinatorWriteGuard denies a coordinator tracked-file mutation under strict enforcement", () => {
  const d = decideCoordinatorWriteGuard({ filePath: "packages/core/src/x.mjs", isRepoMutation: true, enforce: true, agentType: "dev-loop" });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /Coordinator→worker delegation boundary/);
  assert.match(d.reason, /x\.mjs/);
});

test("decideCoordinatorWriteGuard's deny for a gate coordinator names its own path, not a worker dispatch", () => {
  for (const agentType of ["gate-coordinator", "dev-loops:gate-coordinator"]) {
    const d = decideCoordinatorWriteGuard({ filePath: "packages/core/src/x.mjs", isRepoMutation: true, enforce: true, agentType });
    assert.equal(d.decision, "deny");
    assert.match(d.reason, /x\.mjs/);
    assert.match(d.reason, /typed observation/);
    assert.doesNotMatch(d.reason, /worker subagent/);
  }
});

test("decideCoordinatorWriteGuard allows a worker subagent tracked-file mutation under strict enforcement", () => {
  for (const agentType of ["developer", "fixer", "quality", "docs"]) {
    const d = decideCoordinatorWriteGuard({ filePath: "packages/core/src/x.mjs", isRepoMutation: true, enforce: true, agentType });
    assert.equal(d.decision, "allow", `worker agent_type ${agentType} must not be denied by the coordinator boundary`);
  }
});

test("decideCoordinatorWriteGuard allows a coordinator writing a non-repo/gitignored path (tmp/scratchpad) under strict enforcement", () => {
  assert.equal(
    decideCoordinatorWriteGuard({ filePath: "tmp/scratch.txt", isRepoMutation: false, enforce: true, agentType: "dev-loop" }).decision,
    "allow",
  );
});

test("decideCoordinatorWriteGuard allows a null agent_type (main agent — the other boundary's job, not this one)", () => {
  assert.equal(
    decideCoordinatorWriteGuard({ filePath: "packages/core/src/x.mjs", isRepoMutation: true, enforce: true, agentType: null }).decision,
    "allow",
  );
});

test("decideCoordinatorWriteGuard denies a namespaced dev-loops:dev-loop coordinator tracked-file mutation under strict enforcement (#2082 pre-PR review)", () => {
  const d = decideCoordinatorWriteGuard({ filePath: "packages/core/src/x.mjs", isRepoMutation: true, enforce: true, agentType: "dev-loops:dev-loop" });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /Coordinator→worker delegation boundary/);
});

test("decideCoordinatorWriteGuard allows a namespaced dev-loops:developer worker tracked-file mutation under strict enforcement (#2082 pre-PR review)", () => {
  const d = decideCoordinatorWriteGuard({ filePath: "packages/core/src/x.mjs", isRepoMutation: true, enforce: true, agentType: "dev-loops:developer" });
  assert.equal(d.decision, "allow");
});

// ---------------------------------------------------------------------------
// normalizeAgentType (#2082 pre-PR review) — plugin-namespaced agent_type discriminator
// ---------------------------------------------------------------------------

test("normalizeAgentType strips a plugin-name: prefix and passes bare/null/non-string values through", () => {
  assert.equal(normalizeAgentType("dev-loops:dev-loop"), "dev-loop");
  assert.equal(normalizeAgentType("dev-loops:developer"), "developer");
  assert.equal(normalizeAgentType("dev-loop"), "dev-loop");
  assert.equal(normalizeAgentType(null), null);
  assert.equal(normalizeAgentType(undefined), undefined);
});

// ---------------------------------------------------------------------------
// decideSubagentStopGuard (#1619)
// ---------------------------------------------------------------------------

const WT = "/Users/mfittko/github/dev-loops/tmp/worktrees/dev-loops/issue-1619";

// Mutation anchor: if the guard is reverted (no block on dirty porcelain), this fails. The
// refusal names LOCAL-COMMIT-BEFORE-EXIT (#1619 AC).
test("decideSubagentStopGuard blocks a subagent stop with a dirty worktree under tmp/worktrees/, naming LOCAL-COMMIT-BEFORE-EXIT and the dirty paths", () => {
  const porcelain = [" M packages/core/src/claude/hook-decisions.mjs", "?? .claude/hooks/subagent-stop-uncommitted-guard.mjs"].join("\n");
  const d = decideSubagentStopGuard({ cwd: WT, porcelain });
  assert.equal(d.decision, "block");
  assert.match(d.reason, /LOCAL-COMMIT-BEFORE-EXIT/);
  assert.match(d.reason, /hook-decisions\.mjs/);
  assert.match(d.reason, /subagent-stop-uncommitted-guard\.mjs/);
});

test("decideSubagentStopGuard allows a clean worktree (empty porcelain)", () => {
  assert.equal(decideSubagentStopGuard({ cwd: WT, porcelain: "" }).decision, "allow");
});

test("decideSubagentStopGuard allows a clean worktree (whitespace-only porcelain)", () => {
  assert.equal(decideSubagentStopGuard({ cwd: WT, porcelain: "   \n  " }).decision, "allow");
});

test("decideSubagentStopGuard allows a non-string porcelain (git error) — fail safe, allow the stop", () => {
  assert.equal(decideSubagentStopGuard({ cwd: WT, porcelain: undefined }).decision, "allow");
});

test("decideSubagentStopGuard is unaffected by a cwd outside tmp/worktrees/ (main checkout)", () => {
  const d = decideSubagentStopGuard({ cwd: "/Users/mfittko/github/dev-loops", porcelain: " M src/x.mjs" });
  assert.equal(d.decision, "allow");
});

test("decideSubagentStopGuard is unaffected by a cwd outside tmp/worktrees/ (arbitrary path)", () => {
  assert.equal(decideSubagentStopGuard({ cwd: "/tmp", porcelain: " M x" }).decision, "allow");
});

test("decideSubagentStopGuard exempts an interactive session awaiting commit authorization", () => {
  // Same dirty porcelain + worktree cwd that would otherwise block, but the pending-commit-
  // authorization exemption (set by the interactive coordination path) allows the stop.
  const d = decideSubagentStopGuard({
    cwd: WT,
    porcelain: " M src/x.mjs\n?? y",
    pendingCommitAuthorization: true,
  });
  assert.equal(d.decision, "allow");
});

test("decideSubagentStopGuard blocks when pendingCommitAuthorization is false (non-interactive dispatched subagent)", () => {
  const d = decideSubagentStopGuard({ cwd: WT, porcelain: " M src/x.mjs", pendingCommitAuthorization: false });
  assert.equal(d.decision, "block");
  assert.match(d.reason, /LOCAL-COMMIT-BEFORE-EXIT/);
});

// #1936: the #1786 `orchestratorOwnsCommit` env-var exemption was REMOVED. The "edit here,
// commit there" split it enabled hard-deadlocked an editing subagent under a task-scoped
// no-commit instruction: the guard demanded a commit the session then denied, then re-blocked
// the exit. Editing sub-delegates now commit their own work, so the guard stays the enforcer.
test("decideSubagentStopGuard ignores a removed orchestratorOwnsCommit flag — no env-var escape (#1936)", () => {
  // Passing the (now-unused) flag must NOT exempt: a dirty editing dispatch still blocks, so the
  // only resolution is to commit its own work — never a denied-commit deadlock loop. This is the
  // mutation anchor for the removed exemption: reintroducing an `orchestratorOwnsCommit` allow
  // branch would flip this to "allow" and re-open the deadlock seam.
  const d = decideSubagentStopGuard({ cwd: WT, porcelain: " M src/x.mjs", orchestratorOwnsCommit: true });
  assert.equal(d.decision, "block");
  assert.match(d.reason, /LOCAL-COMMIT-BEFORE-EXIT/);
});

test("decideSubagentStopGuard treats a non-string cwd as out-of-scope (allow)", () => {
  assert.equal(decideSubagentStopGuard({ cwd: undefined, porcelain: " M x" }).decision, "allow");
});

// Read-only role exemption (#1925): a judge/review subagent's contract forbids commits, so a
// dirty tracked edit in its worktree is foreign (orchestrator-owned). The guard must not force
// the read-only role to commit it, and its message must name the orchestrator as responsible.
for (const role of ["judge", "review", "gate-coordinator", "dev-loops:judge", "dev-loops:review", "dev-loops:gate-coordinator"]) {
  test(`decideSubagentStopGuard exempts a read-only "${role}" role from committing foreign uncommitted work (#1925)`, () => {
    const d = decideSubagentStopGuard({ cwd: WT, porcelain: " M src/gate-fanin.mjs", agentType: role });
    assert.equal(d.decision, "allow");
    assert.equal(d.advisory, true);
    assert.match(d.reason, /ORCHESTRATOR/);
    assert.match(d.reason, new RegExp(role));
    // Not re-blocked: the verdict-only role is never told to commit.
    assert.doesNotMatch(d.reason, /Commit your work before stopping/);
  });
}

// Non-goal anchor (#1925) + deadlock-resolution pin (#1936): editing roles and the orchestrator
// stay enforced (the read-only exemption must not regress into a blanket agentType-based allow),
// AND the block resolves without a denied-commit deadlock because the actionable escape is to
// commit the role's OWN work — never a task-scoped no-commit instruction the session then denies.
for (const role of ["developer", "fixer", "docs", "quality", "dev-loops:developer", "dev-loops:fixer", "dev-loops:docs", "dev-loops:quality"]) {
  test(`decideSubagentStopGuard blocks an editing "${role}" role with a dirty worktree and points it at self-commit (#1925 non-goal, #1936)`, () => {
    const d = decideSubagentStopGuard({ cwd: WT, porcelain: " M src/x.mjs", agentType: role });
    assert.equal(d.decision, "block");
    assert.match(d.reason, /LOCAL-COMMIT-BEFORE-EXIT/);
    // The resolution is deadlock-free: commit your own work (no orchestrator-owned-commit split).
    assert.match(d.reason, /Commit your work before stopping/);
  });
}

test("decideSubagentStopGuard still blocks a null agentType (main-agent / unknown dispatch) with a dirty worktree (#1925)", () => {
  const d = decideSubagentStopGuard({ cwd: WT, porcelain: " M src/x.mjs", agentType: null });
  assert.equal(d.decision, "block");
  assert.match(d.reason, /LOCAL-COMMIT-BEFORE-EXIT/);
});

test("decideSubagentStopGuard allows a read-only role with a CLEAN worktree without an advisory (#1925)", () => {
  const d = decideSubagentStopGuard({ cwd: WT, porcelain: "", agentType: "judge" });
  assert.equal(d.decision, "allow");
  assert.notEqual(d.advisory, true);
});

test("decideSubagentStopGuard caps the enumerated dirty paths at 50, reports the full count, and preserves porcelain order", () => {
  // Descending index order (not ascending/sorted) so the assertions can tell "preserves
  // porcelain order" apart from "sorts the paths" — git porcelain lists tracked
  // staged/modified paths before untracked ones, and a sort creeping into the decider would
  // displace the higher-data-loss-risk entries out of the first 50 shown.
  const lines = Array.from({ length: 120 }, (_, i) => `?? file-${String(119 - i).padStart(3, "0")}.txt`);
  const d = decideSubagentStopGuard({ cwd: WT, porcelain: lines.join("\n") });
  assert.equal(d.decision, "block");
  assert.match(d.reason, /Dirty paths \(120\):/);
  assert.match(d.reason, /file-119\.txt/);
  assert.match(d.reason, /file-070\.txt/);
  assert.doesNotMatch(d.reason, /file-069\.txt/);
  assert.match(d.reason, /… and 70 more/);
  const firstListedPath = d.reason.split("\n")[1].trim();
  assert.equal(firstListedPath, lines[0], "first listed path must be the first porcelain line verbatim (order preserved, not sorted)");
});

test("decideSubagentStopGuard lists all paths with no truncation summary at exactly the 50-path cap", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `?? file-${String(i).padStart(3, "0")}.txt`);
  const d = decideSubagentStopGuard({ cwd: WT, porcelain: lines.join("\n") });
  assert.equal(d.decision, "block");
  assert.match(d.reason, /Dirty paths \(50\):/);
  assert.match(d.reason, /file-049\.txt/);
  assert.doesNotMatch(d.reason, /… and/);
});

test("decideSubagentStopGuard adds a one-more truncation summary at 51 dirty paths (smallest over-cap input)", () => {
  const lines = Array.from({ length: 51 }, (_, i) => `?? file-${String(i).padStart(3, "0")}.txt`);
  const d = decideSubagentStopGuard({ cwd: WT, porcelain: lines.join("\n") });
  assert.equal(d.decision, "block");
  assert.match(d.reason, /Dirty paths \(51\):/);
  assert.match(d.reason, /file-049\.txt/);
  assert.doesNotMatch(d.reason, /file-050\.txt/);
  assert.match(d.reason, /… and 1 more/);
});

// ---------------------------------------------------------------------------
// decideBashGate — the six guard rules enforced at one seam (#1622)
// ---------------------------------------------------------------------------

test("decideBashGate denies inline interpreters actor-independently on the target repo (OPS-NO-INLINE-INTERPRETER)", () => {
  const d = decideBashGate({ command: 'node -e "console.log(1)"', repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /OPS-NO-INLINE-INTERPRETER/);
  // actor-independent: denied from the main agent too (agentType null)
  const dMain = decideBashGate({ command: "python3 -c 'print(1)'", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: null });
  assert.equal(dMain.decision, "deny");
  assert.match(dMain.reason, /OPS-NO-INLINE-INTERPRETER/);
});

test("decideBashGate allows sanctioned node/python script invocations and off-target inline interpreters", () => {
  assert.equal(decideBashGate({ command: "node scripts/github/comment-issue.mjs 5", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET }).decision, "allow");
  assert.equal(decideBashGate({ command: 'node -e "console.log(1)"', repoSlug: "someone/else", inManagedContext: true, managedRepoSlug: TARGET }).decision, "allow");
});

test("decideBashGate denies sub_issues ad-hoc writes naming SUBISSUE-NO-ADHOC-BYPASS (actor-independent)", () => {
  const d = decideBashGate({ command: "gh api -X POST repos/mfittko/dev-loops/issues/5/sub_issues -f child=6", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: null });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /SUBISSUE-NO-ADHOC-BYPASS/);
  // a read passes; the sanctioned wrapper passes
  assert.equal(decideBashGate({ command: "gh api repos/mfittko/dev-loops/issues/5/sub_issues", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET }).decision, "allow");
  assert.equal(decideBashGate({ command: "node scripts/github/manage-sub-issues.mjs --repo x", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET }).decision, "allow");
});

test("decideBashGate denies thread-reply bypasses naming COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER", () => {
  const rest = decideBashGate({ command: "gh api -X POST repos/mfittko/dev-loops/pulls/5/comments/10/replies -f body=hi", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: null });
  assert.equal(rest.decision, "deny");
  assert.match(rest.reason, /COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER/);
  const gql = decideBashGate({ command: "gh api graphql -f query='mutation { resolveReviewThread }'", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: null });
  assert.equal(gql.decision, "deny");
  assert.match(gql.reason, /COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER/);
  // graphql resolveReviewThread is scoped to the target repo (cwd)
  assert.equal(decideBashGate({ command: "gh api graphql -f query='mutation { resolveReviewThread }'", repoSlug: "someone/else", inManagedContext: true, managedRepoSlug: TARGET, agentType: null }).decision, "allow");
  assert.equal(decideBashGate({ command: "node scripts/github/reply-resolve-review-thread.mjs --thread 5", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET }).decision, "allow");
});

test("decideBashGate denies Copilot review-request bypasses naming COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY", () => {
  const api = decideBashGate({ command: "gh api -X POST repos/mfittko/dev-loops/pulls/5/requested_reviewers -f reviewers[]=copilot-swe-agent", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: null });
  assert.equal(api.decision, "deny");
  assert.match(api.reason, /COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY/);
  // a bare /copilot comment summon is refused even from the main agent (actor-independent)
  const summon = decideBashGate({ command: 'gh pr comment 5 --body "/copilot re-review"', repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: null });
  assert.equal(summon.decision, "deny");
  assert.match(summon.reason, /COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY/);
  assert.equal(decideBashGate({ command: "node scripts/github/request-copilot-review.mjs --pr 5", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET }).decision, "allow");
});

// #2065: the detached-wait gate is now ACTOR-INDEPENDENT — the coordinator/main agent (agentType
// null) is the actor that leaves backgrounded poll loops / bare-`&` probe shells orphaned under
// Claude Code, so the gate denies its backgrounding too, not only a subagent's.
test("decideBashGate denies detached wait tools for BOTH the coordinator and a subagent (COPILOT-FOLLOWUP-WAIT-TOOLS, #2065)", () => {
  // #1622: a detach mechanism (here nohup) denies UNCONDITIONALLY — no wait/probe FAMILY reference
  // is required (see the dedicated family-less regression test below). The command here also names
  // `probe-copilot-review.mjs`, so it denies under both the #1622 detach-wrapper rule and the #2065
  // family rule.
  const detached = "nohup node scripts/github/probe-copilot-review.mjs --pr 5 > /tmp/x.log 2>&1 &";
  const sub = decideBashGate({ command: detached, repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: "dev-loop" });
  assert.equal(sub.decision, "deny");
  assert.match(sub.reason, /COPILOT-FOLLOWUP-WAIT-TOOLS/);
  // coordinator/main agent (no agent_type) is NO LONGER exempt (#2065)
  const main = decideBashGate({ command: detached, repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: null });
  assert.equal(main.decision, "deny");
  assert.match(main.reason, /COPILOT-FOLLOWUP-WAIT-TOOLS/);
  // off-target passes through (both actors)
  assert.equal(decideBashGate({ command: detached, repoSlug: "someone/else", inManagedContext: true, managedRepoSlug: TARGET, agentType: "dev-loop" }).decision, "allow");
  assert.equal(decideBashGate({ command: detached, repoSlug: "someone/else", inManagedContext: true, managedRepoSlug: TARGET, agentType: null }).decision, "allow");
  // the refusal body names the bounded FOREGROUND probe path and the banned detach forms, uncorrupted
  const reason = decideBashGate({ command: detached, repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: null }).reason;
  assert.match(reason, /gh run watch/);
  assert.match(reason, /nohup\/disown\/tmux\/screen/);
  assert.match(reason, /probe-copilot-review\.mjs/);
  assert.doesNotMatch(reason, /NaN/);
});

// #2317: a bare FILE-MARKER poll loop (no gh/loop-state call) is a separate orphan pattern — a
// `<tasks>/<id>.done` sentinel Claude Code never writes, so the loop never exits and, once
// backgrounded, orphans with no async wake to reap it. Actor-independent, verb-independent.
test("decideBashGate denies bare file-marker poll loops for BOTH the coordinator and a subagent (#2317)", () => {
  const whileLoop = 'while [ ! -f "$T/$A.done" ]; do sleep 5; done';
  const untilLoop = "until [ -e /tmp/a.done ]; do sleep 10; done";
  for (const cmd of [whileLoop, untilLoop]) {
    for (const agentType of [null, "dev-loop"]) {
      const d = decideBashGate({ command: cmd, repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType });
      assert.equal(d.decision, "deny", `expected deny for agentType=${agentType}, command=${cmd}`);
      assert.match(d.reason, /COPILOT-FOLLOWUP-WAIT-TOOLS/);
    }
    // off-target passes through (both actors)
    assert.equal(decideBashGate({ command: cmd, repoSlug: "someone/else", inManagedContext: true, managedRepoSlug: TARGET, agentType: "dev-loop" }).decision, "allow");
    assert.equal(decideBashGate({ command: cmd, repoSlug: "someone/else", inManagedContext: true, managedRepoSlug: TARGET, agentType: null }).decision, "allow");
  }
  // False-positive allow at the gate: a quoted --body payload merely mentioning while/sleep/done is
  // not a real loop construct. Use agentType: null (main agent) — a subagent `gh issue create` is
  // denied for a DIFFERENT reason (the external-write ban), which would mask the poll-loop fix.
  const quotedBody = decideBashGate({
    command: 'gh issue create --title x --body "while [ -f x.done ]; do sleep 5; done"',
    repoSlug: TARGET,
    inManagedContext: true,
    managedRepoSlug: TARGET,
    agentType: null,
  });
  assert.equal(quotedBody.decision, "allow");
});

// H3 (#2317 Copilot follow-up regression): a double-quoted command substitution ($(...)) must not be
// blanked by stripQuotedLiterals — its content executes regardless of the surrounding quotes, so a
// natural poll idiom `while [ "$(gh pr view 5)" != MERGED ]; do sleep 5; done` must still be denied
// by the pre-existing gh/loop-state ban, for both the coordinator/main agent and a subagent.
test("decideBashGate denies a command-substitution poll loop for BOTH the coordinator and a subagent (COPILOT-FOLLOWUP-WAIT-TOOLS, #2317 regression)", () => {
  const cmdSubstLoop = 'while [ "$(gh pr view 5)" != MERGED ]; do sleep 5; done';
  for (const agentType of [null, "dev-loop"]) {
    const d = decideBashGate({ command: cmdSubstLoop, repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType });
    assert.equal(d.decision, "deny", `expected deny for agentType=${agentType}`);
    assert.match(d.reason, /COPILOT-FOLLOWUP-WAIT-TOOLS/);
  }
});

// H1 (#2317 follow-up): stripQuotedLiterals's `-c` exemption was too narrow — only a bare `-c`
// preserved its quoted payload, so `bash -lc '…'` blanked its REAL shell payload and a genuine
// gh poll loop wrapped in it slipped through the gate undetected. Actor-independent, gate-level
// no-regression guard for the widened exemption.
test("decideBashGate denies a bash -lc-wrapped gh poll loop for BOTH the coordinator and a subagent (H1, #2317)", () => {
  const cmd = "bash -lc 'until gh pr view 5; do sleep 5; done'";
  for (const agentType of [null, "dev-loop"]) {
    const d = decideBashGate({ command: cmd, repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType });
    assert.equal(d.decision, "deny", `expected deny for agentType=${agentType}`);
    assert.match(d.reason, /COPILOT-FOLLOWUP-WAIT-TOOLS/);
  }
});

// H2 (#2317 follow-up): stripQuotedLiterals's `-c`-cluster exemption required `c` to be the LAST
// character of the short-flag cluster, but bash executes the quoted payload for ANY cluster
// CONTAINING `-c`, regardless of position (`bash -cl '…'` executes the payload too). Actor-
// independent, gate-level no-regression guard for the widened exemption.
test("decideBashGate denies a bash -cl-wrapped gh poll loop for BOTH the coordinator and a subagent (H2, #2317)", () => {
  const cmd = "bash -cl 'until gh pr view 5; do sleep 5; done'";
  for (const agentType of [null, "dev-loop"]) {
    const d = decideBashGate({ command: cmd, repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType });
    assert.equal(d.decision, "deny", `expected deny for agentType=${agentType}`);
    assert.match(d.reason, /COPILOT-FOLLOWUP-WAIT-TOOLS/);
  }
});

// #1622 regression guard: the #2065 OPTION-C rework must NOT narrow the pre-existing unconditional
// detach-wrapper ban to "detach AND family reference". A family-less nohup/disown/tmux/screen
// detach still denies outright, for both the main/coordinator (agentType null) and a subagent.
test("decideBashGate denies a family-less nohup detach wrapper for BOTH the coordinator and a subagent (#1622 regression)", () => {
  const familyLess = "nohup node scripts/foo.mjs > /tmp/x.log 2>&1 &";
  for (const agentType of [null, "dev-loop"]) {
    const d = decideBashGate({ command: familyLess, repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType });
    assert.equal(d.decision, "deny", `expected deny for agentType=${agentType}`);
    assert.match(d.reason, /COPILOT-FOLLOWUP-WAIT-TOOLS/);
  }
  // off-target passes through (both actors)
  assert.equal(decideBashGate({ command: familyLess, repoSlug: "someone/else", inManagedContext: true, managedRepoSlug: TARGET, agentType: "dev-loop" }).decision, "allow");
  assert.equal(decideBashGate({ command: familyLess, repoSlug: "someone/else", inManagedContext: true, managedRepoSlug: TARGET, agentType: null }).decision, "allow");
});

// #2065 AC2: both a backgrounded probe script AND a sleep-poll wait loop are denied for a
// main/coordinator invocation (no agent_type) AND a subagent invocation.
test("decideBashGate denies a bare-& backgrounded probe and a sleep-poll loop for coordinator and subagent (#2065)", () => {
  const bgProbe = "node scripts/github/probe-copilot-review.mjs --repo mfittko/dev-loops --pr 5 --timeout-ms 300000 &";
  const pollLoop = "until gh pr view 5 --json state; do sleep 5; done";
  for (const agentType of [null, "dev-loop"]) {
    const p = decideBashGate({ command: bgProbe, repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType });
    assert.equal(p.decision, "deny", `backgrounded probe (agentType=${agentType})`);
    assert.match(p.reason, /COPILOT-FOLLOWUP-WAIT-TOOLS/);
    const l = decideBashGate({ command: pollLoop, repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType });
    assert.equal(l.decision, "deny", `sleep-poll loop (agentType=${agentType})`);
    assert.match(l.reason, /COPILOT-FOLLOWUP-WAIT-TOOLS/);
  }
  // A bounded FOREGROUND probe (no background &) is allowed for both actors.
  const fg = "node scripts/github/probe-copilot-review.mjs --repo mfittko/dev-loops --pr 5 --timeout-ms 300000";
  assert.equal(decideBashGate({ command: fg, repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: null }).decision, "allow");
  assert.equal(decideBashGate({ command: fg, repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: "dev-loop" }).decision, "allow");
});

// Copilot review (#2065): the detached-wait deny is evaluated BEFORE the gh pr create/ready/merge
// classification, so a compound command cannot short-circuit past it via a lifecycle-verb ALLOW path.
test("decideBashGate denies a backgrounded probe even when paired with a lifecycle verb (no compound short-circuit)", () => {
  // out-of-scope create (would take the create ALLOW path) chained with a backgrounded probe
  const withForeignCreate = "gh pr create --repo other/repo --fill && node scripts/github/probe-copilot-review.mjs --pr 5 &";
  const d1 = decideBashGate({ command: withForeignCreate, repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: null });
  assert.equal(d1.decision, "deny");
  assert.match(d1.reason, /COPILOT-FOLLOWUP-WAIT-TOOLS/);
  // gh pr ready (a gated verb) chained with a backgrounded probe
  const withReady = "gh pr ready 5 && node scripts/github/wait-pr-checks.mjs --pr 5 &";
  const d2 = decideBashGate({ command: withReady, repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: "dev-loop" });
  assert.equal(d2.decision, "deny");
  assert.match(d2.reason, /COPILOT-FOLLOWUP-WAIT-TOOLS/);
});

// #2065 AC2/AC3 (OPTION-C, prevention-only): the coarse fail-closed classifier denies a
// backgrounded wait/probe command through every wrapper form below — none can hide the
// wait/probe FAMILY reference from the coarse whole-string scan — for BOTH a main/coordinator
// invocation (no agent_type) AND a subagent invocation. A sleep-poll wait loop is denied
// outright (AC3: fails closed on an ambiguous/wrapped wait command rather than allowing it).
test("decideBashGate denies every wrapper form of a backgrounded wait/probe, for coordinator AND subagent (#2065 AC2/AC3)", () => {
  const commands = [
    // bare backgrounded probe
    "node scripts/github/probe-copilot-review.mjs --repo mfittko/dev-loops --pr 5 &",
    // timeout-wrapped
    "timeout 600 node scripts/github/probe-copilot-review.mjs --repo mfittko/dev-loops --pr 5 &",
    // nohup-wrapped
    "nohup node scripts/github/probe-copilot-review.mjs --repo mfittko/dev-loops --pr 5 &",
    // sh -c wrapped (a naive exec-position parser cannot see inside the quoted subshell)
    "sh -c 'node scripts/github/probe-copilot-review.mjs --repo mfittko/dev-loops --pr 5 &'",
    // a value-taking node loader flag ahead of the script path
    "node --require ./loader.mjs scripts/github/probe-copilot-review.mjs --repo mfittko/dev-loops --pr 5 &",
    // ambiguous/wrapped sleep-poll wait loop (AC3: fails closed rather than allowing it)
    "timeout 600 sh -c 'until gh pr view 5 --json state; do sleep 5; done'",
  ];
  for (const command of commands) {
    for (const agentType of [null, "dev-loop"]) {
      const d = decideBashGate({ command, repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType });
      assert.equal(d.decision, "deny", `expected deny for agentType=${agentType}: ${command}`);
      assert.match(d.reason, /COPILOT-FOLLOWUP-WAIT-TOOLS/);
    }
  }
  // the sanctioned bounded FOREGROUND probe (no backgrounding) remains allowed for both actors
  const fg = "node scripts/github/probe-copilot-review.mjs --repo mfittko/dev-loops --pr 5 --timeout-ms 0";
  assert.equal(decideBashGate({ command: fg, repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: null }).decision, "allow");
  assert.equal(decideBashGate({ command: fg, repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: "dev-loop" }).decision, "allow");
});

test("decideBashGate gates relative-endpoint gh api writes to the target repo", () => {
  // bare relative endpoint (resolved against the cwd repo) is denied in the target repo
  const d = decideBashGate({ command: "gh api -X POST issues/5/sub_issues -f child=6", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: null });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /SUBISSUE-NO-ADHOC-BYPASS/);
  // the same relative write outside the target repo is NOT this repo's bypass
  assert.equal(decideBashGate({ command: "gh api -X POST issues/5/sub_issues -f child=6", repoSlug: "someone/else", inManagedContext: true, managedRepoSlug: TARGET, agentType: null }).decision, "allow");
  // --repo-targeted relative writes to the target repo are denied
  assert.equal(decideBashGate({ command: "gh api --repo mfittko/dev-loops pulls/5/requested_reviewers -X POST", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType: null }).decision, "deny");
});

test("decideBashGate refuses gh pr merge under humanMergeOnly, actor-independently (STOP-HUMAN-MERGE-001)", () => {
  const d = decideBashGate({ command: "gh pr merge 1 --squash", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, humanMergeOnly: true, gatePassed: true, agentType: null });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /STOP-HUMAN-MERGE-001/);
  // refusal holds regardless of gate evidence (the human-merge invariant overrides)
  const dNoEvidence = decideBashGate({ command: "gh pr merge 1 --squash", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, humanMergeOnly: true, gatePassed: false, agentType: null });
  assert.equal(dNoEvidence.decision, "deny");
  assert.match(dNoEvidence.reason, /STOP-HUMAN-MERGE-001/);
  // without humanMergeOnly a raw merge is still forbidden outright (route through the wrapper)
  const dNoHumanOnly = decideBashGate({ command: "gh pr merge 1 --squash", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, humanMergeOnly: false, gatePassed: true, agentType: null });
  assert.equal(dNoHumanOnly.decision, "deny");
  assert.match(dNoHumanOnly.reason, /gh pr merge is forbidden/);
  // non-target repo is unaffected by this repo's humanMergeOnly invariant
  assert.equal(decideBashGate({ command: "gh pr merge 1 --squash", repoSlug: "someone/else", inManagedContext: true, managedRepoSlug: TARGET, humanMergeOnly: true, gatePassed: true, agentType: null }).decision, "allow");
});

// ---------------------------------------------------------------------------
// decideBashGate — managed-repo predicate (#2187): the guard suite must apply in ANY
// dev-loops-managed consumer repo, not just the hardcoded mfittko/dev-loops slug, and must fail
// CLOSED (guards still apply) when the managed identity can't be resolved inside a managed context.
// ---------------------------------------------------------------------------

const CONSUMER = "acme/widgets";
const CONSUMER_CTX = { inManagedContext: true, managedRepoSlug: CONSUMER, repoSlug: CONSUMER };

test("decideBashGate denies a raw gh pr merge in a non-mfittko managed repo (RAW-GH-PR-MERGE-BYPASS)", () => {
  const d = decideBashGate({ command: "gh pr merge 5", ...CONSUMER_CTX });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /gh pr merge is forbidden/);
});

test("decideBashGate denies gh pr ready without gate evidence in a non-mfittko managed repo", () => {
  const d = decideBashGate({ command: "gh pr ready 5", ...CONSUMER_CTX, gatePassed: false });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /no visible clean draft_gate/);
});

test("decideBashGate refuses gh pr merge under humanMergeOnly in a non-mfittko managed repo (STOP-HUMAN-MERGE-001)", () => {
  const d = decideBashGate({ command: "gh pr merge 5", ...CONSUMER_CTX, humanMergeOnly: true, gatePassed: true });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /STOP-HUMAN-MERGE-001/);
});

test("decideBashGate denies an inline interpreter in a non-mfittko managed repo (OPS-NO-INLINE-INTERPRETER)", () => {
  const d = decideBashGate({ command: 'node -e "console.log(1)"', ...CONSUMER_CTX });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /OPS-NO-INLINE-INTERPRETER/);
});

test("decideBashGate denies sub-issue ad-hoc writes (absolute + bare relative) in a non-mfittko managed repo", () => {
  const abs = decideBashGate({ command: "gh api -X POST repos/acme/widgets/issues/5/sub_issues -f child=6", ...CONSUMER_CTX });
  assert.equal(abs.decision, "deny");
  assert.match(abs.reason, /SUBISSUE-NO-ADHOC-BYPASS/);
  const rel = decideBashGate({ command: "gh api -X POST issues/5/sub_issues -f child=6", ...CONSUMER_CTX });
  assert.equal(rel.decision, "deny");
  assert.match(rel.reason, /SUBISSUE-NO-ADHOC-BYPASS/);
});

test("decideBashGate denies reply-resolve bypasses in a non-mfittko managed repo", () => {
  const d = decideBashGate({
    command: "gh api -X POST repos/acme/widgets/pulls/5/comments/9/replies -f body=hi",
    ...CONSUMER_CTX,
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER/);
});

test("decideBashGate denies Copilot review-request bypasses in a non-mfittko managed repo", () => {
  const d = decideBashGate({
    command: "gh api -X POST repos/acme/widgets/pulls/5/requested_reviewers -f reviewers[]=copilot-swe-agent",
    ...CONSUMER_CTX,
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY/);
});

test("decideBashGate denies git stash in a non-mfittko managed repo", () => {
  const d = decideBashGate({ command: "git stash", ...CONSUMER_CTX });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /git stash blocked/);
});

test("decideBashGate denies a detached wait tool from the dev-loop agent in a non-mfittko managed repo", () => {
  // COARSE + FAIL-CLOSED (#2065 OPTION-C): a bare backgrounded wait/probe family reference denies
  // outright — no detach mechanism (nohup) is even needed once the command carries the family token.
  const d = decideBashGate({ command: "node scripts/github/probe-copilot-review.mjs --pr 1 &", ...CONSUMER_CTX, agentType: "dev-loop" });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /COPILOT-FOLLOWUP-WAIT-TOOLS/);
});

test("decideBashGate passes an explicit non-managed --repo through, even in a managed context (AC3)", () => {
  assert.equal(
    decideBashGate({ command: "gh pr merge --repo other/repo 5", ...CONSUMER_CTX }).decision,
    "allow",
  );
});

test("decideBashGate does not match a foreign repo's absolute sub-issue path against the managed slug (AC3)", () => {
  assert.equal(
    decideBashGate({ command: "gh api -X POST repos/other/repo/issues/5/sub_issues -f child=6", ...CONSUMER_CTX }).decision,
    "allow",
  );
});

test("decideBashGate fails closed when the managed context's identity is unresolvable (AC4)", () => {
  const ambiguous = { inManagedContext: true, managedRepoSlug: null, repoSlug: null };
  assert.equal(decideBashGate({ command: "gh pr merge 5", ...ambiguous }).decision, "deny");
  assert.equal(decideBashGate({ command: "gh pr ready 5", ...ambiguous, gatePassed: false }).decision, "deny");
  assert.equal(decideBashGate({ command: 'node -e "x"', ...ambiguous }).decision, "deny");
});

test("decideBashGate allows everything in a non-managed context (dev-loops does not manage this repo)", () => {
  const unmanaged = { inManagedContext: false, managedRepoSlug: null, repoSlug: CONSUMER };
  assert.equal(decideBashGate({ command: "gh pr merge 5", ...unmanaged }).decision, "allow");
  assert.equal(decideBashGate({ command: "gh pr ready 5", ...unmanaged, gatePassed: false }).decision, "allow");
  assert.equal(
    decideBashGate({ command: "gh pr merge 5", ...unmanaged, humanMergeOnly: true, gatePassed: true }).decision,
    "allow",
  );
  assert.equal(decideBashGate({ command: 'node -e "x"', ...unmanaged }).decision, "allow");
  assert.equal(
    decideBashGate({ command: "gh api -X POST repos/acme/widgets/issues/5/sub_issues -f child=6", ...unmanaged }).decision,
    "allow",
  );
  assert.equal(
    decideBashGate({ command: "gh api -X POST issues/5/sub_issues -f child=6", ...unmanaged }).decision,
    "allow",
  );
  assert.equal(
    decideBashGate({
      command: "gh api -X POST repos/acme/widgets/pulls/5/comments/9/replies -f body=hi",
      ...unmanaged,
    }).decision,
    "allow",
  );
  assert.equal(
    decideBashGate({
      command: "gh api -X POST repos/acme/widgets/pulls/5/requested_reviewers -f reviewers[]=copilot-swe-agent",
      ...unmanaged,
    }).decision,
    "allow",
  );
  assert.equal(decideBashGate({ command: "git stash", ...unmanaged }).decision, "allow");
  assert.equal(
    decideBashGate({ command: "nohup sleep 1 &", ...unmanaged, agentType: "dev-loop" }).decision,
    "allow",
  );
});

// ---------------------------------------------------------------------------
// decideWorktreeCheckoutGuard
// ---------------------------------------------------------------------------

const WCG_WT = "/repo/tmp/worktrees/dev-loops/issue-1994";

test("decideWorktreeCheckoutGuard allows when no worktree is active (main/orchestrator context, AC3)", () => {
  assert.equal(
    decideWorktreeCheckoutGuard({ filePath: "/repo/scripts/x.mjs", activeWorktreeRoot: null, isMainCheckoutTracked: true }).decision,
    "allow",
  );
});

test("decideWorktreeCheckoutGuard allows a legitimate in-worktree edit (AC2)", () => {
  // isMainCheckoutTracked:true makes this discriminating — the allow MUST come
  // from the isTargetUnderActiveWorktree branch, not the later !tracked branch,
  // so removing the in-worktree branch would flip this to deny.
  assert.equal(
    decideWorktreeCheckoutGuard({
      filePath: `${WCG_WT}/scripts/x.mjs`,
      activeWorktreeRoot: WCG_WT,
      isTargetUnderActiveWorktree: true,
      isMainCheckoutTracked: true,
    }).decision,
    "allow",
  );
});

test("decideWorktreeCheckoutGuard denies a main-checkout write while a worktree is active (AC1)", () => {
  const d = decideWorktreeCheckoutGuard({
    filePath: "/repo/scripts/x.mjs",
    activeWorktreeRoot: WCG_WT,
    isTargetUnderActiveWorktree: false,
    isMainCheckoutTracked: true,
    suggestedWorktreePath: `${WCG_WT}/scripts/x.mjs`,
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /WORKTREE-WRONG-CHECKOUT-GUARD: wrong-checkout mutation blocked/);
  // the fix names the worktree-local path to use instead
  assert.match(d.reason, new RegExp(`${WCG_WT}/scripts/x\\.mjs`));
  assert.match(d.reason, /DEVLOOPS_ALLOW_MAIN=1/);
});

test("decideWorktreeCheckoutGuard fails safe on an unresolvable/ambiguous context (AC4)", () => {
  // The hook sets isMainCheckoutTracked=true when tracked-status is unresolvable
  // (e.g. git check-ignore errored) — an ambiguous active-worktree context must
  // not silently allow a wrong-checkout write.
  const d = decideWorktreeCheckoutGuard({
    filePath: "/repo/scripts/x.mjs",
    activeWorktreeRoot: WCG_WT,
    isTargetUnderActiveWorktree: false,
    isMainCheckoutTracked: true,
  });
  assert.equal(d.decision, "deny");
});

test("decideWorktreeCheckoutGuard allows a deliberate main-checkout edit under the override (AC3)", () => {
  assert.equal(
    decideWorktreeCheckoutGuard({
      filePath: "/repo/scripts/x.mjs",
      activeWorktreeRoot: WCG_WT,
      isTargetUnderActiveWorktree: false,
      isMainCheckoutTracked: true,
      allowMainCheckout: true,
    }).decision,
    "allow",
  );
});

test("decideWorktreeCheckoutGuard allows an outside-repo / gitignored scratch write while a worktree is active", () => {
  assert.equal(
    decideWorktreeCheckoutGuard({
      filePath: "/tmp/note.md",
      activeWorktreeRoot: WCG_WT,
      isTargetUnderActiveWorktree: false,
      isMainCheckoutTracked: false,
    }).decision,
    "allow",
  );
});

test("WORKTREE_CHECKOUT_GUARD_OVERRIDE_ENV reuses the default-branch-guard override (one operator flag)", () => {
  assert.equal(WORKTREE_CHECKOUT_GUARD_OVERRIDE_ENV, "DEVLOOPS_ALLOW_MAIN");
});

// ---------------------------------------------------------------------------
// decideFixerWriteGuard (ADR 0107, #2420 F5)
// ---------------------------------------------------------------------------

const FX_MAIN = "/repo";
const FX_WT = "/repo/tmp/worktrees/dev-loops/issue-1";
const FX_CHECKOUTS = [{ root: FX_MAIN, branch: "main" }, { root: FX_WT, branch: "issue-1" }];
const FX_OUTPUT = `${FX_MAIN}/tmp/gate-fixer/o-r/pr-1/f1-0000abcd/fixer-disposition.json`;
const FX_GRANT = { branch: "issue-1", allowedPaths: ["src", "test/a.test.mjs"], outputRef: FX_OUTPUT };
const fixer = (targetPath, over = {}) => decideFixerWriteGuard({ agentType: "fixer", targetPath, checkouts: FX_CHECKOUTS, grants: [FX_GRANT], ...over });

test("decideFixerWriteGuard allows the outputRef and in-authority paths of a current pull", () => {
  assert.equal(fixer(FX_OUTPUT).decision, "allow");
  assert.equal(fixer(`${FX_WT}/src/x.mjs`).decision, "allow");
  assert.equal(fixer(`${FX_WT}/test/a.test.mjs`).decision, "allow");
  assert.equal(fixer(`${FX_WT}/src/x.mjs`, { agentType: "dev-loops:fixer" }).decision, "allow");
  assert.equal(fixer(`${FX_WT}/README.md`, { grants: [{ ...FX_GRANT, allowedPaths: ["."] }] }).decision, "allow");
});

test("decideFixerWriteGuard denies every in-checkout write without a current pull", () => {
  const d = fixer(`${FX_WT}/src/x.mjs`, { grants: [] });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /pull-work-order\.mjs --ref <ref> --digest <digest> --execution <execution>/);
  assert.match(d.reason, /no current fixer work-order pull/);
});

test("decideFixerWriteGuard never widens authority: other path, branch, checkout or evidence roots stay denied", () => {
  assert.equal(fixer(`${FX_WT}/test/b.test.mjs`).decision, "deny");
  assert.equal(fixer(`${FX_WT}/srcx/y.mjs`).decision, "deny");
  assert.equal(fixer(`${FX_MAIN}/src/x.mjs`).decision, "deny");
  assert.equal(fixer(`${FX_MAIN}/tmp/work-order-receipts/abc.json`).decision, "deny");
  assert.equal(fixer(`${FX_MAIN}/tmp/gate-fixer/o-r/pr-1/fixer-emit-plan.json`).decision, "deny");
  const grantMain = { ...FX_GRANT, branch: "main", allowedPaths: ["."] };
  assert.equal(fixer(`${FX_MAIN}/tmp/work-order-receipts/abc.json`, { grants: [grantMain] }).decision, "deny");
  for (const rel of ["tmp/src/act.json", "tmp/gate-findings/x.json", "tmp/gate-fixer/o-r/pr-1/f1-0000abcd/other.json"]) {
    assert.equal(fixer(`${FX_MAIN}/${rel}`, { grants: [grantMain] }).decision, "deny", rel);
  }
  assert.equal(fixer(`${FX_MAIN}/src/x.mjs`, { grants: [grantMain] }).decision, "allow");
  assert.equal(fixer(FX_OUTPUT, { grants: [{ ...grantMain, outputRef: `${FX_OUTPUT}.other` }] }).decision, "deny", "only the exact outputRef");
  assert.match(fixer(`${FX_WT}/test/b.test.mjs`).reason, /"test\/b\.test\.mjs" on branch "issue-1"/);
});

test("decideFixerWriteGuard allows scratch outside every checkout and fails closed on unresolvable input", () => {
  assert.equal(fixer("/private/tmp/scratch.txt", { grants: [] }).decision, "allow");
  assert.equal(fixer(null).decision, "deny");
  assert.equal(fixer("src/x.mjs").decision, "deny");
  assert.equal(fixer(`${FX_WT}/src/x.mjs`, { symlinked: true }).decision, "deny");
  assert.equal(fixer("/private/tmp/scratch.txt", { checkouts: [] }).decision, "deny");
});

test("decideFixerWriteGuard leaves every non-fixer agent to the other boundaries", () => {
  for (const agentType of [null, "developer", "dev-loop", "judge"]) {
    assert.equal(decideFixerWriteGuard({ agentType, targetPath: `${FX_MAIN}/src/x.mjs`, checkouts: [], grants: [] }).decision, "allow");
  }
});

test("decideBashGate lets the judge run only the sanctioned work-order pull, fail-closed (ADR 0106)", () => {
  const pull = "dev-loops-run scripts/github/pull-work-order.mjs --ref judge:o/r#7:draft_gate:abc:j1-aa --digest ab12 --execution j1-aa";
  assert.equal(decideBashGate({ command: pull, agentType: "judge" }).decision, "allow");
  assert.equal(decideBashGate({ command: ` ${pull}\n`, agentType: "dev-loops:judge" }).decision, "allow");
  for (const command of [undefined, "ls", "bun test", "node scripts/github/pull-work-order.mjs --ref a --digest b --execution c", `${pull} | tee x`, `${pull} \`id\``, `${pull} --tmp-root /x`]) {
    assert.equal(decideBashGate({ command, agentType: "judge" }).decision, "deny", String(command));
  }
  assert.equal(decideBashGate({ command: "bun test", agentType: "review" }).decision, "allow");
});

test("decideJudgeWriteGuard lets the judge write only its verdict files under an anchored gate-judge root, fail-closed (ADR 0106)", () => {
  const gateJudgeRoots = ["/r/tmp/gate-judge", "/r/tmp/worktrees/w/tmp/gate-judge"];
  const dir = "/r/tmp/gate-judge/o-r/pr-7/draft_gate-abc/j1-aa";
  for (const agentType of ["judge", "dev-loops:judge"]) {
    assert.equal(decideJudgeWriteGuard({ agentType, targetPath: `${dir}/judge-verdict.json`, gateJudgeRoots }).decision, "allow");
    assert.equal(decideJudgeWriteGuard({ agentType, targetPath: `${dir}/spec-authority-verdict.json`, gateJudgeRoots }).decision, "allow");
  }
  assert.equal(decideJudgeWriteGuard({ agentType: "judge", targetPath: "/r/tmp/worktrees/w/tmp/gate-judge/o-r/x/judge-verdict.json", gateJudgeRoots }).decision, "allow");
  for (const targetPath of [null, "", "tmp/gate-judge/o-r/judge-verdict.json", "/r/scripts/github/pull-work-order.mjs", "/r/package.json",
    `${dir}/package.json`, `${dir}/judge-emit-plan.json`, "/r/tmp/gate-judge/judge-verdict.json", `${dir}/../../../../../scripts/judge-verdict.json`,
    "/r/gate-judge/o-r/pr-7/x/judge-verdict.json", "/r/tmp/gate-context/o-r/pr-7/x/judge-verdict.json",
    "/private/tmp/gate-judge/z/judge-verdict.json", "/r/scripts/tmp/gate-judge/z/judge-verdict.json", "/r/tmp/gate-judge-x/z/judge-verdict.json"]) {
    assert.equal(decideJudgeWriteGuard({ agentType: "judge", targetPath, gateJudgeRoots }).decision, "deny", String(targetPath));
  }
  assert.equal(decideJudgeWriteGuard({ agentType: "judge", targetPath: `${dir}/judge-verdict.json` }).decision, "deny", "no roots denies");
  assert.equal(decideJudgeWriteGuard({ agentType: "judge", targetPath: `${dir}/judge-verdict.json`, gateJudgeRoots, symlinked: true }).decision, "deny", "symlink denies");
  assert.equal(decideJudgeWriteGuard({ agentType: "developer", targetPath: "/r/package.json" }).decision, "allow");
  assert.equal(decideJudgeWriteGuard({ agentType: null, targetPath: null }).decision, "allow");
});

// ---------------------------------------------------------------------------
// decideAgentDispatch: only the gate coordinator dispatches the round's
// review and judge agents, and only with the emitted dispatchPrompt verbatim.
// ---------------------------------------------------------------------------

const pointer = (role) => buildDispatchPointer({ workOrderRef: `${role}:o/r#7:draft_gate:abc123:u1`, workOrderDigest: "ab12cd", executionIdentity: "x1-aa" });
const dispatch = (callerAgentType, targetAgentType, prompt = "anything") => decideAgentDispatch({ callerAgentType, targetAgentType, prompt });

test("decideAgentDispatch denies gate-pointer review and judge dispatches from the dev-loop coordinator", () => {
  for (const caller of ["dev-loop", "dev-loops:dev-loop"]) {
    for (const target of ["review", "judge", "dev-loops:review"]) {
      const d = dispatch(caller, target, pointer("review"));
      assert.equal(d.decision, "deny", `${caller} -> ${target}`);
      assert.match(d.reason, /^GATE_COORDINATOR_REQUIRED/);
      assert.match(d.reason, /GATE-EXEC-GATE-COORDINATOR/);
      assert.match(d.reason, /`gate-coordinator` agent/);
    }
  }
});

test("decideAgentDispatch denies every judge dispatch from the dev-loop coordinator, pointer or not", () => {
  for (const caller of ["dev-loop", "dev-loops:dev-loop"]) {
    for (const prompt of [pointer("judge"), "Judge PR 7.", "", null]) {
      const d = dispatch(caller, "judge", prompt);
      assert.equal(d.decision, "deny", `${caller} ${JSON.stringify(prompt)}`);
      assert.match(d.reason, /^GATE_COORDINATOR_REQUIRED/);
    }
  }
});

test("decideAgentDispatch denies a dev-loop review dispatch that carries a wrapped work-order pull", () => {
  const p = pointer("review");
  for (const caller of ["dev-loop", "dev-loops:dev-loop"]) {
    for (const target of ["review", "dev-loops:review"]) {
      for (const prompt of [`${p}\n`, ` ${p}`, `cd /w && ${p}`, `${p} Also check the docs.`, pointer("judge"), "Run `dev-loops-run scripts/github/pull-work-order.mjs r1-aaaaaaaa-u0`; follow it."]) {
        const d = dispatch(caller, target, prompt);
        assert.equal(d.decision, "deny", `${caller} -> ${target} ${JSON.stringify(prompt)}`);
        assert.match(d.reason, /^GATE_COORDINATOR_REQUIRED/);
      }
    }
  }
});

test("decideAgentDispatch allows the dev-loop coordinator's prose-briefed pre-PR and delta review dispatches", () => {
  for (const caller of ["dev-loop", "dev-loops:dev-loop"]) {
    for (const target of ["review", "dev-loops:review"]) {
      for (const prompt of [
        "Pre-PR full review of branch issue-7 against origin/main.",
        "Delta review of the act-list fix: git diff abc123..def456.",
        "Delta review: the fix edits scripts/github/pull-work-order.mjs; check its --ref parsing.",
        "Pre-PR review of changes to pull-work-order.mjs and its tests.",
        "",
        null,
      ]) {
        assert.equal(dispatch(caller, target, prompt).decision, "allow", `${caller} -> ${target} ${JSON.stringify(prompt)}`);
      }
    }
  }
});

test("decideAgentDispatch allows the gate coordinator to relay an emitted pointer of the same role", () => {
  for (const caller of ["gate-coordinator", "dev-loops:gate-coordinator"]) {
    assert.equal(dispatch(caller, "review", pointer("review")).decision, "allow");
    assert.equal(dispatch(caller, "judge", pointer("judge")).decision, "allow");
    assert.equal(dispatch(caller, "dev-loops:judge", pointer("judge")).decision, "allow");
  }
});

test("decideAgentDispatch denies a gate-coordinator relay that is not the emitted pointer verbatim", () => {
  const p = pointer("review");
  for (const prompt of [
    `Review PR 7 carefully.\n${p}`,
    `${p}\nAlso check the tests.`,
    `${p} `,
    `${p}\n`,
    `${p}\r\n`,
    `cd /tmp/worktrees/pr-7 && ${p}`,
    pointer("judge"),
    `${p} --same-head-retry`,
    "",
    null,
  ]) {
    const d = dispatch("gate-coordinator", "review", prompt);
    assert.equal(d.decision, "deny", JSON.stringify(prompt));
    assert.match(d.reason, /^GATE_DISPATCH_NOT_VERBATIM/);
  }
  assert.equal(dispatch("gate-coordinator", "judge", pointer("review")).decision, "deny");
});

test("decideAgentDispatch denies every other target from the gate coordinator", () => {
  for (const target of ["fixer", "developer", "dev-loop", "general-purpose", "gate-coordinator", null]) {
    const d = dispatch("gate-coordinator", target, pointer("review"));
    assert.equal(d.decision, "deny", String(target));
    assert.match(d.reason, /^GATE_COORDINATOR_DISPATCH_SCOPE/);
  }
});

test("decideAgentDispatch does not block other dispatches", () => {
  for (const target of ["developer", "fixer", "docs", "quality", "general-purpose", "gate-coordinator"]) {
    assert.equal(dispatch("dev-loop", target).decision, "allow", target);
  }
  for (const target of ["review", "judge"]) {
    assert.equal(dispatch(null, target, "Review PR 7 with the correctness angle.").decision, "allow", `main session -> ${target}`);
    assert.equal(dispatch(undefined, target).decision, "allow");
  }
  assert.equal(dispatch("developer", "review").decision, "allow");
});

test("the gate coordinator keeps the dev-loop coordinator boundaries under strict mode", () => {
  for (const agentType of ["gate-coordinator", "dev-loops:gate-coordinator"]) {
    assert.equal(decideCoordinatorWriteGuard({ filePath: "packages/core/src/x.mjs", isRepoMutation: true, enforce: true, agentType }).decision, "deny");
    const d = decideBashGate({ command: "bun run verify", repoSlug: TARGET, inManagedContext: true, managedRepoSlug: TARGET, agentType, enforceCoordinator: true });
    assert.equal(d.decision, "deny");
    assert.match(d.reason, /COORDINATOR-VERIFY-BOUNDARY/);
  }
});
