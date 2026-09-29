#!/usr/bin/env node
/**
 * PreToolUse Bash gate hook (#773).
 *
 * Blocks these commands on the target repo; everything else passes through:
 *   - `gh pr create` — blocked outright (no gate evidence to check): PR creation must flow through
 *     the canonical wrapper scripts/github/create-pr.mjs (dev-loops pr create), which always drafts
 *     and self-assigns. Closes the hole where raw `gh pr create` opens a ready PR (draft-first breach).
 *   - `gh pr ready` — needs a clean draft_gate verdict (via scripts/loop/pre-pr-ready-gate.mjs).
 *   - `gh pr merge` — blocked outright; use scripts/github/merge-pr.mjs. Its gate evidence check
 *     requires a clean draft_gate transition record + current-head pre_approval_gate
 *     (GATE-COMMENT-DRAFT-REQUIREMENTS in skills/docs/gate-review-comment-contract.md).
 *   - raw `gh issue create` / `gh issue comment` / `gh pr comment` — blocked only from a SUBAGENT
 *     context (agent_type present); the main agent/operator retains direct issue creation (#1051).
 *   - `git stash` — blocked outright: `refs/stash` is shared across every worktree over this
 *     repo's one `.git` directory (skills/docs/worktree-guidance.md#never-git-stash-in-a-shared-git-layout).
 *   - `bun run verify` / `bun test` / `vitest` / `npm test` / `npm run test` / `bun run build` /
 *     `npm run build` (and yarn/pnpm equivalents) — blocked ONLY from the dev-loop COORDINATOR
 *     (agent_type "dev-loop" or "gate-coordinator"), opt-in via `DEVLOOPS_COORDINATOR_READONLY=1` (#2082). Worker
 *     subagents (developer/fixer/quality/review) may run these freely.
 *   - the `fixer` agent passes through, and its exact sanctioned work-order pull line
 *     records its agent_id as the binding the Write/Edit guard checks (ADR 0107); a modified
 *     fixer pull line (prefix, suffix, redirect, `cd`) is denied with the exact line to run.
 *     The fixer Bash commit/push boundary is owned by issue 2534.
 *   - every command from the read-only `judge` subagent except its sanctioned work-order pull
 *     (`dev-loops-run scripts/github/pull-work-order.mjs <executionIdentity>` or the 3-flag line, ADR 0106, ADR 0115).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { JUDGE_AGENT_TYPE, decideBashGate, FIXER_AGENT_TYPE, isFixerPullAttempt, normalizeAgentType, parseSanctionedPullLine } from "./_hook-decisions.mjs";
import { listCheckouts, parseFixerPullCommand, recordFixerAgentBinding } from "./_fixer-grants.mjs";
import {
  commandContainsGhPrReady,
  commandContainsGhPrMerge,
  commandContainsGhPrCreate,
  commandContainsRawExternalWrite,
  commandContainsGitStash,
  commandContainsInlineInterpreter,
  commandContainsSubIssueAdHocBypass,
  commandContainsReplyResolveBypass,
  commandContainsGraphqlResolveReviewThread,
  commandContainsCopilotRequestBypass,
  commandContainsCopilotSummonComment,
  commandContainsDetachedWaitTool,
  commandContainsCodeVerificationEntrypoint,
  extractPrNumberFromGhPrReadyAnywhere,
  extractPrNumberFromGhPrMergeAnywhere,
  normalizeGitHubRepoSlug,
} from "./_bash-command-classify.mjs";

import { readHookInput, emitDeny, emitAllow } from "./_hook-io.mjs";

const input = readHookInput();
const command = input?.tool_input?.command;
// Claude exposes `agent_type` only inside a subagent; null in the main agent. Scopes the
// external-write guard (raw `gh issue create` etc. is blocked only from a subagent).
const agentType = typeof input?.agent_type === "string" ? input.agent_type : null;

const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd();

// Fixer grant binding (ADR 0107): the sanctioned pull line binds the pull's grant to this fixer's
// agent_id (see _fixer-grants.mjs); the Write/Edit guard honors only a bound grant.
const isFixer = normalizeAgentType(agentType) === FIXER_AGENT_TYPE;
const mainRoot = isFixer && parseSanctionedPullLine(command) ? listCheckouts(cwd)[0]?.root : null;
const fixerPull = mainRoot ? parseFixerPullCommand(command, mainRoot) : null;
if (fixerPull) recordFixerAgentBinding(mainRoot, { agentId: input?.agent_id, ...fixerPull });

let repoRoot = null;
let repoSlug = null;
try {
  repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  repoSlug = normalizeGitHubRepoSlug(remote);
} catch {
  // Not a git repo / no remote — repoSlug stays null; decider passes through.
}

// A repo is dev-loops-managed when a `.devloops` config exists at its root (the dev-loops-driven
// context) — replaces the old hardcoded-slug (`repoSlug === TARGET_REPO_SLUG`) comparison so the
// guard suite applies in any managed consumer repo, not only mfittko/dev-loops. The config loader
// (packages/core/src/config/config.mjs) accepts a bare `.devloops` file OR any of the
// `.yaml`/`.yml`/`.json` extensions; this hook is self-contained (cannot import @dev-loops/core),
// so the same small variant list is replicated inline rather than hardcoding the bare filename —
// a consumer configured via `.devloops.yaml` alone must still be recognized as managed, or every
// guard below fails open for it.
const DEVLOOPS_CONFIG_VARIANTS = ["", ".yaml", ".yml", ".json"];
const inManagedContext =
  repoRoot != null && DEVLOOPS_CONFIG_VARIANTS.some((ext) => fs.existsSync(path.join(repoRoot, `.devloops${ext}`)));
const managedRepoSlug = inManagedContext ? repoSlug : null;

// The quick pre-check booleans below must be computed AFTER managedRepoSlug resolves: the three
// gh-api classifiers match the managed repo's absolute `repos/<slug>/...` path form only when
// given that slug, so computing them before resolution (with an implicit null slug) would miss an
// absolute-path match and wrongly short-circuit to allow.
const isReady = typeof command === "string" && commandContainsGhPrReady(command);
const isMerge = typeof command === "string" && commandContainsGhPrMerge(command);
const isCreate = typeof command === "string" && commandContainsGhPrCreate(command);
const isExternalWrite = typeof command === "string" && commandContainsRawExternalWrite(command);
const isStash = typeof command === "string" && commandContainsGitStash(command);
// The six-guard-rule predicates (#1622) — each is decided (with scope + actor policy) inside
// decideBashGate, so the hook must not short-circuit to allow before deciding them.
const isInline = typeof command === "string" && commandContainsInlineInterpreter(command);
const isSubIssue = typeof command === "string" && commandContainsSubIssueAdHocBypass(command, managedRepoSlug);
const isReplyResolve =
  typeof command === "string" &&
  (commandContainsReplyResolveBypass(command, managedRepoSlug) || commandContainsGraphqlResolveReviewThread(command));
const isRequestApi = typeof command === "string" && commandContainsCopilotRequestBypass(command, managedRepoSlug);
const isCopilotSummon = typeof command === "string" && commandContainsCopilotSummonComment(command);
const isWaitTool = typeof command === "string" && commandContainsDetachedWaitTool(command);
// COORDINATOR-VERIFY-BOUNDARY (#2082) — actor-scoped inside decideBashGate (agentType is
// "dev-loop" or "gate-coordinator"), so the quick pre-check here only detects the command shape; the hook must not
// short-circuit to allow before the decider applies the actor + enforceCoordinator scoping.
const isVerifyEntrypoint = typeof command === "string" && commandContainsCodeVerificationEntrypoint(command);
// The read-only judge may run only its work-order pull (ADR 0106); every judge command reaches the decider.
const isJudge = normalizeAgentType(agentType) === JUDGE_AGENT_TYPE;
// A fixer pull attempt reaches the decider, which denies any line other than the exact one.
const isFixerPull = isFixer && isFixerPullAttempt(command);
if (
  !isReady && !isMerge && !isCreate && !isExternalWrite && !isStash &&
  !isInline && !isSubIssue && !isReplyResolve && !isRequestApi && !isCopilotSummon && !isWaitTool &&
  !isVerifyEntrypoint && !isJudge && !isFixerPull
) {
  emitAllow();
}

let gatePassed = false;
let gateError = null;
let humanMergeOnly = false;
if (inManagedContext) {
  // When both verbs appear (compound command), apply the stricter merge gate.
  const pr = isMerge ? extractPrNumberFromGhPrMergeAnywhere(command) : extractPrNumberFromGhPrReadyAnywhere(command);
  // STOP-HUMAN-MERGE-001 (#1622): resolve the repo's effective `autonomy.humanMergeOnly` via the
  // repo-root script (the hook bundle is self-contained and cannot import @dev-loops/core); fail
  // open (false) when the script is unavailable so the loop-level merge safety remains authoritative.
  if (isMerge && repoRoot) {
    try {
      humanMergeOnly = execFileSync("node", [path.join(repoRoot, "scripts/loop/resolve-human-merge-only.mjs")], {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim() === "true";
    } catch {
      humanMergeOnly = false;
    }
  }
  // The gate scripts need `--repo <slug>`; when repoSlug is unresolved, skip running them and
  // leave gatePassed=false — the decider then denies ready/merge fail-closed rather than running
  // an ambiguous-repo evidence check.
  if (pr !== null && repoRoot && repoSlug) {
    // Each gate script is overridable for deterministic testing (stub instead of the
    // network-touching real guard). `gh pr ready` → draft-gate only; `gh pr merge` → the full
    // pre-merge evidence check (draft_gate + pre_approval_gate).
    const gateScript = isMerge
      ? process.env.DEVLOOPS_PRE_MERGE_GATE_SCRIPT ||
        path.join(repoRoot, "scripts/github/detect-checkpoint-evidence.mjs")
      : process.env.DEVLOOPS_PRE_PR_READY_GATE_SCRIPT || path.join(repoRoot, "scripts/loop/pre-pr-ready-gate.mjs");
    try {
      execFileSync("node", [gateScript, "--repo", repoSlug, "--pr", String(pr)], {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "pipe"],
      });
      gatePassed = true;
    } catch (error) {
      // Exit 1 from the guard = gate evidence missing/insufficient (gatePassed stays false).
      // A missing/unspawnable guard (no numeric status) = could-not-run → gateError.
      if (typeof error?.status !== "number") {
        gateError = "could not run the gate guard script";
      }
    }
  }
}

// Boundary 3 (#2082): the coordinator verify-command delegation boundary, gated by the SAME flag
// as boundary 3 of pre-tool-use-write-guard.mjs (decideCoordinatorWriteGuard).
const enforceCoordinator = process.env.DEVLOOPS_COORDINATOR_READONLY === "1";

const decision = decideBashGate({
  command,
  repoSlug,
  managedRepoSlug,
  inManagedContext,
  gatePassed,
  gateError,
  agentType,
  humanMergeOnly,
  enforceCoordinator,
});
if (decision.decision === "deny") {
  emitDeny(decision.reason);
}
emitAllow();
