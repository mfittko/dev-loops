#!/usr/bin/env node
/**
 * PreToolUse Write/Edit guard hook (#773, #1994).
 *
 * Two independent boundaries on a Write/Edit:
 *
 * 1. WRONG-CHECKOUT guard (#1994, always on): when the call context is operating
 *    inside a linked worktree (the active cycle worktree) but the target resolves
 *    to a TRACKED file in the MAIN checkout, the mutation would silently land on
 *    the wrong checkout and be lost from the branch. Denied before it reaches a
 *    commit. Override a deliberate main-checkout edit with DEVLOOPS_ALLOW_MAIN=1.
 *
 * 2. Main-agent read-only boundary (#773, opt-in via DEVLOOPS_MAIN_AGENT_READONLY=1,
 *    default fail-open): denies a Write/Edit whose target is inside the repo working
 *    tree AND not gitignored when the call originates from the MAIN agent; allowed
 *    inside the dev-loop subagent context (CA2 DEVLOOPS_RUN_ID, or Claude
 *    agent_type === "dev-loop").
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

import { decideWriteGuard, decideWorktreeCheckoutGuard, WORKTREE_CHECKOUT_GUARD_OVERRIDE_ENV } from "./_hook-decisions.mjs";
import { isMainCheckout, parseMainWorktreePath, parseAllWorktreePaths, resolveContainingWorktreeRoot } from "./_worktree-guard.mjs";

import { readHookInput, emitDeny, emitAllow } from "./_hook-io.mjs";

const input = readHookInput();
const filePath = input?.tool_input?.file_path;
if (typeof filePath !== "string" || !filePath) {
  emitAllow();
}

const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd();
const abs = path.resolve(cwd, filePath);

// --- Boundary 1: wrong-checkout guard (#1994, always on) ---------------------
// Resolve the active worktree from `git worktree list`. The active worktree is
// the one containing cwd — anchoring on cwd (not on the mere existence of a
// worktree) keeps the guard immune to the many stale tmp/worktrees/ worktrees
// this repo accumulates.
try {
  const worktreeOutput = execFileSync("git", ["worktree", "list"], { cwd, encoding: "utf8" });
  const activeWorktreeRoot = resolveContainingWorktreeRoot(cwd, parseAllWorktreePaths(worktreeOutput));
  if (activeWorktreeRoot) {
    const mainWorktreePath = parseMainWorktreePath(worktreeOutput);
    const isTargetUnderActiveWorktree = isMainCheckout(abs, activeWorktreeRoot);
    // Tracked main-checkout file? Under the main checkout AND not gitignored.
    // Fail SAFE (AC4): if the status is unresolvable (check-ignore error), treat
    // it as tracked so an ambiguous context never silently allows the write.
    let isMainCheckoutTracked = false;
    let suggestedWorktreePath = null;
    if (!isTargetUnderActiveWorktree && mainWorktreePath && isMainCheckout(abs, mainWorktreePath)) {
      let ignored = false;
      let ignoreResolved = true;
      try {
        // `git check-ignore -q` exits 0 when ignored, 1 when not ignored.
        execFileSync("git", ["check-ignore", "-q", "--", abs], { cwd: mainWorktreePath, stdio: "ignore" });
        ignored = true;
      } catch (err) {
        // exit 1 = not ignored (resolved); any other failure = unresolvable.
        ignoreResolved = err?.status === 1;
        ignored = false;
      }
      isMainCheckoutTracked = ignoreResolved ? !ignored : true;
      if (isMainCheckoutTracked) {
        suggestedWorktreePath = path.join(activeWorktreeRoot, path.relative(mainWorktreePath, abs));
      }
    }
    const allowMainCheckout = process.env[WORKTREE_CHECKOUT_GUARD_OVERRIDE_ENV] === "1";
    const checkoutDecision = decideWorktreeCheckoutGuard({
      filePath,
      activeWorktreeRoot,
      isTargetUnderActiveWorktree,
      isMainCheckoutTracked,
      allowMainCheckout,
      suggestedWorktreePath,
    });
    if (checkoutDecision.decision === "deny") {
      emitDeny(checkoutDecision.reason);
    }
  }
} catch {
  // `git worktree list` failed (not a git repo, git unavailable): cannot
  // establish an active worktree context — fall through to boundary 2.
}

// --- Boundary 2: main-agent read-only boundary (#773, opt-in) ----------------
const enforce = process.env.DEVLOOPS_MAIN_AGENT_READONLY === "1";
// Claude exposes `agent_type` (the agent name) only inside a subagent. Only the dev-loop
// subagent is authorized to mutate — a generic subagent must not bypass the boundary.
const agentType = typeof input?.agent_type === "string" ? input.agent_type : null;

// Repo mutation = inside the repo working tree AND not gitignored.
let isRepoMutation = false;
try {
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  if (abs === repoRoot || abs.startsWith(repoRoot + path.sep)) {
    let ignored = false;
    try {
      // `git check-ignore -q` exits 0 when ignored, 1 when not ignored.
      execFileSync("git", ["check-ignore", "-q", "--", abs], { cwd: repoRoot, stdio: "ignore" });
      ignored = true;
    } catch {
      ignored = false;
    }
    isRepoMutation = !ignored;
  }
} catch {
  isRepoMutation = false; // not a git repo / path outside any repo
}

const decision = decideWriteGuard({ filePath, isRepoMutation, enforce, env: process.env, agentType });
if (decision.decision === "deny") {
  emitDeny(decision.reason);
}
emitAllow();
