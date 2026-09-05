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
import { isMainCheckout, isUnderWorktreePath, parseMainWorktreePath, parseAllWorktreePaths, resolveContainingWorktreeRoot, realpathNearestExisting, resolveTrackedFromCheckIgnore } from "./_worktree-guard.mjs";

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
    // Realpath-normalize the target against its nearest EXISTING ancestor so a
    // Write creating a new (nonexistent) file is classified with the same
    // symlink-resolved prefix the worktree/main roots already carry (#1994) —
    // otherwise an under-a-symlinked-ancestor new-file write is misclassified.
    const absReal = realpathNearestExisting(abs);
    const isTargetUnderActiveWorktree = isMainCheckout(absReal, activeWorktreeRoot);
    // Guarded main-checkout file? Under the main checkout AND not gitignored.
    // Fail SAFE (AC4): an unresolvable check-ignore status is treated as guarded
    // so an ambiguous context never silently allows the write.
    let isMainCheckoutTracked = false;
    let suggestedWorktreePath = null;
    if (!isTargetUnderActiveWorktree && mainWorktreePath && isMainCheckout(absReal, mainWorktreePath)) {
      // `git check-ignore -q` exits 0 when ignored, 1 when not ignored; a throw
      // carries the exit code on err.status (null when git could not run at all).
      let checkIgnoreStatus = 0;
      try {
        execFileSync("git", ["check-ignore", "-q", "--", absReal], { cwd: mainWorktreePath, stdio: "ignore" });
        checkIgnoreStatus = 0;
      } catch (err) {
        checkIgnoreStatus = typeof err?.status === "number" ? err.status : null;
      }
      isMainCheckoutTracked = resolveTrackedFromCheckIgnore(checkIgnoreStatus);
      if (isMainCheckoutTracked) {
        // Compute the advisory fix-path from the realpath-normalized main root so
        // the hint stays correct under a symlinked main root (absReal is already
        // realpath-normalized; a raw base would skew the relative path).
        suggestedWorktreePath = path.join(activeWorktreeRoot, path.relative(realpathNearestExisting(mainWorktreePath), absReal));
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
  // `git worktree list` failed (not a git repo, git unavailable). If cwd is
  // itself inside a worktree, the active-worktree context is real but
  // UNRESOLVABLE — fail SAFE (AC4) instead of falling through to boundary 2's
  // fail-open path: refuse a write that escapes cwd's own subtree (a likely
  // wrong-checkout target) unless a deliberate main-checkout edit is authorized.
  // An in-cwd-subtree write still passes. When cwd is NOT under a worktree there
  // is no active context to protect, so fall through unchanged.
  if (isUnderWorktreePath(cwd) && process.env[WORKTREE_CHECKOUT_GUARD_OVERRIDE_ENV] !== "1") {
    const absReal = realpathNearestExisting(abs);
    const cwdReal = realpathNearestExisting(cwd);
    const underCwd = absReal === cwdReal || absReal.startsWith(cwdReal + "/");
    if (!underCwd) {
      emitDeny(
        `WORKTREE-WRONG-CHECKOUT-GUARD: wrong-checkout mutation blocked — cwd is inside a worktree ` +
        `("${cwdReal}") but \`git worktree list\` could not resolve the active worktree, and this ` +
        `Write/Edit targets "${filePath}", outside cwd's subtree. Failing safe on an unresolvable ` +
        "active-worktree context. Set DEVLOOPS_ALLOW_MAIN=1 only for a deliberate main-checkout edit.",
      );
    }
  }
  // Otherwise fall through to boundary 2.
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
