#!/usr/bin/env node
/**
 * PreToolUse Write/Edit guard hook (#773).
 *
 * Independent boundaries on a Write/Edit:
 *
 * 0. FIXER mutation boundary (always on, ADR 0107): the `fixer` agent writes only
 *    inside the mutation authority of a current work-order pull (see the block below).
 *
 * 0. JUDGE write boundary (always on, ADR 0106): the read-only `judge` agent may
 *    write only judge-verdict.json / spec-authority-verdict.json under a listed
 *    checkout's tmp/gate-judge/ (realpath-resolved, no symlink on the way); every
 *    other target, and a missing or unparseable path, is denied.
 *
 * 1. WRONG-CHECKOUT guard (always on): when the call context is operating
 *    inside a linked worktree (the active cycle worktree) but the target resolves
 *    to a TRACKED file in the MAIN checkout, the mutation would silently land on
 *    the wrong checkout and be lost from the branch. Denied before it reaches a
 *    commit. Override a deliberate main-checkout edit with DEVLOOPS_ALLOW_MAIN=1.
 *
 * 2. Main-agent read-only boundary (#773, opt-in via DEVLOOPS_MAIN_AGENT_READONLY=1,
 *    default fail-open): denies a repo-mutation Write/Edit from the MAIN agent and from
 *    unknown subagents. A run id (CA2 DEVLOOPS_RUN_ID) or the dev-loop agent type is
 *    authorized. Worker agents (developer, fixer, quality, docs; bare name or the
 *    dev-loops: namespace only) are authorized only when the target is inside a linked
 *    worktree. A repo mutation is a target inside a repository working tree and not
 *    gitignored; any path under a `.git` segment is also a repo mutation.
 *
 * 3. Coordinator→worker delegation boundary (#2082, opt-in via
 *    DEVLOOPS_COORDINATOR_READONLY=1, default fail-open): the INVERSE of boundary 2, one
 *    level down. Denies a tracked-repo-file Write/Edit whose Claude agent_type is
 *    a coordinator's own ("dev-loop" or "gate-coordinator"); the coordinator must delegate the edit to a fresh
 *    worker subagent (developer/fixer/quality/docs). Reuses the same isRepoMutation/
 *    agentType facts computed for boundary 2.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

import { decideFixerWriteGuard, FIXER_AGENT_TYPE, decideJudgeWriteGuard, JUDGE_AGENT_TYPE, normalizeAgentType, decideWriteGuard, decideCoordinatorWriteGuard, decideWorktreeCheckoutGuard, WORKTREE_CHECKOUT_GUARD_OVERRIDE_ENV } from "./_hook-decisions.mjs";
import { isMainCheckout, isUnderWorktreePath, parseMainWorktreePath, parseAllWorktreePaths, resolveContainingWorktreeRoot, realpathNearestExisting, resolveTrackedFromCheckIgnore } from "./_worktree-guard.mjs";

import { readHookInput, emitDeny, emitAllow } from "./_hook-io.mjs";
import { gitEnv, loadFixerContext, nearestExistingDir } from "./_fixer-grants.mjs";

const input = readHookInput();
const filePath = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd();

// --- Fixer mutation boundary (ADR 0107, always on) ---------------------------
// A `fixer` writes only inside the mutation authority of a CURRENT work-order pull:
// a main-checkout receipt with role "fixer" whose plan still names the same ref,
// digest and execution, pulled by this agent_id. No pull, a superseded or foreign receipt,
// another agent's pull, another branch or
// a path outside allowedPaths denies before the write; so does an unresolvable target.
if (typeof input?.agent_type === "string" && normalizeAgentType(input.agent_type) === FIXER_AGENT_TYPE) {
  const fixerAbs = typeof filePath === "string" && filePath ? path.resolve(cwd, filePath) : null;
  // The target's repo first, so a cwd outside the repo cannot make an in-repo target look like scratch.
  const { checkouts, grants } = loadFixerContext([...(fixerAbs ? [nearestExistingDir(fixerAbs)] : []), cwd], input?.agent_id);
  const roots = checkouts.map((c) => c.root);
  // A dangling symlink, or one that resolves into a checkout, on the literal path.
  const crossesSymlink = (p) => {
    for (;;) {
      if (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()) {
        let real;
        try { real = realpathNearestExisting(realpathSync(p)); } catch { return true; }
        if (roots.some((r) => real === r || real.startsWith(`${r}/`))) return true;
      }
      if (path.dirname(p) === p) return false;
      p = path.dirname(p);
    }
  };
  const fixerDecision = decideFixerWriteGuard({
    agentType: input.agent_type,
    targetPath: fixerAbs ? realpathNearestExisting(fixerAbs) : null,
    symlinked: fixerAbs ? crossesSymlink(fixerAbs) : false,
    checkouts,
    grants,
  });
  if (fixerDecision.decision === "deny") {
    emitDeny(fixerDecision.reason);
  }
}

// --- Boundary 0: judge write boundary (ADR 0106) ------------------------------
// The read-only judge writes only its two verdict files under a listed checkout's
// tmp/gate-judge/ (the roots the emitter writes and the pull scans). A missing or
// unparseable path, an unresolvable checkout list, or a symlink on the way denies
// fail-closed.
if (typeof input?.agent_type === "string" && normalizeAgentType(input.agent_type) === JUDGE_AGENT_TYPE) {
  const judgeAbs = typeof filePath === "string" && filePath ? path.resolve(cwd, filePath) : null;
  let gateJudgeRoots = [];
  try {
    gateJudgeRoots = parseAllWorktreePaths(execFileSync("git", ["worktree", "list"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))
      .map((root) => `${realpathNearestExisting(root)}/tmp/gate-judge`);
  } catch { /* no git context: no allowed root, so the decider denies */ }
  // realpathNearestExisting walks past a dangling symlink and re-appends its literal name, so
  // lstat every literal component from the target up to its gate-judge root.
  const crossesSymlink = (p) => {
    for (;;) {
      if (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()) return true;
      if (gateJudgeRoots.includes(realpathNearestExisting(p)) || path.dirname(p) === p) return false;
      p = path.dirname(p);
    }
  };
  const judgeDecision = decideJudgeWriteGuard({
    agentType: input.agent_type,
    targetPath: judgeAbs ? realpathNearestExisting(judgeAbs) : null,
    gateJudgeRoots,
    symlinked: judgeAbs ? crossesSymlink(judgeAbs) : false,
  });
  if (judgeDecision.decision === "deny") {
    emitDeny(judgeDecision.reason);
  }
}

if (typeof filePath !== "string" || !filePath) {
  emitAllow();
}

const abs = path.resolve(cwd, filePath);

// --- Boundary 1: wrong-checkout guard (always on) ----------------------------
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
    // symlink-resolved prefix the worktree/main roots already carry —
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

// Repo mutation = inside the working tree of the repository that CONTAINS the target
// (not the hook's cwd) AND not gitignored there. A linked worktree under a gitignored
// directory of the main checkout is its own repository, so its tracked files count.
let isRepoMutation = false;
let inLinkedWorktree = false;
const targetReal = realpathNearestExisting(abs);
try {
  const gitOpts = { encoding: "utf8", env: gitEnv(), stdio: ["ignore", "pipe", "ignore"] };
  const repoRoot = execFileSync("git", ["-C", nearestExistingDir(targetReal), "rev-parse", "--show-toplevel"], gitOpts).trim();
  if (targetReal === repoRoot || targetReal.startsWith(repoRoot + "/")) {
    let ignored = false;
    try {
      // `git check-ignore -q` exits 0 when ignored, 1 when not ignored.
      execFileSync("git", ["check-ignore", "-q", "--", targetReal], { ...gitOpts, cwd: repoRoot });
      ignored = true;
    } catch {
      ignored = false;
    }
    isRepoMutation = !ignored;
    // A linked worktree's git dir differs from the shared common dir; the main checkout's are equal.
    // A lookup failure leaves inLinkedWorktree false and isRepoMutation true (fail closed).
    try {
      const gitDirs = ["--git-dir", "--git-common-dir"].map((flag) =>
        path.resolve(repoRoot, execFileSync("git", ["-C", repoRoot, "rev-parse", flag], gitOpts).trim()));
      inLinkedWorktree = gitDirs[0] !== gitDirs[1];
    } catch {
      inLinkedWorktree = false;
    }
  }
} catch {
  // Outside every repo: allow (the `.git` rule below still applies).
}
// A target under a git directory (.git/hooks, .git/worktrees/<n>, .git/modules/<n>) fails closed on a `.git`
// path segment (a hook write is code execution). rev-parse can fail there, or succeed with a toplevel
// that does not contain the target (a submodule git dir has core.worktree set).
if (targetReal.split("/").includes(".git")) isRepoMutation = true;

const decision = decideWriteGuard({ filePath, isRepoMutation, enforce, env: process.env, agentType, inLinkedWorktree });
if (decision.decision === "deny") {
  emitDeny(decision.reason);
}

// --- Boundary 3: coordinator→worker delegation boundary (#2082, opt-in) -----
const enforceCoordinator = process.env.DEVLOOPS_COORDINATOR_READONLY === "1";
const coordinatorDecision = decideCoordinatorWriteGuard({ filePath, isRepoMutation, enforce: enforceCoordinator, agentType });
if (coordinatorDecision.decision === "deny") {
  emitDeny(coordinatorDecision.reason);
}

emitAllow();
