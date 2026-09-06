#!/usr/bin/env node
/**
 * SubagentStop uncommitted-work guard (#1619).
 *
 * `scripts/loop/cleanup-worktree.mjs` runs `git worktree remove --force` after a merge, so
 * uncommitted changes in a worktree are destroyed with no warning — the only data-loss gap in
 * the enforcement audit. `LOCAL-COMMIT-BEFORE-EXIT` existed only as prose; this hook makes it
 * mechanical: when a subagent stops with a dirty worktree under `tmp/worktrees/`, refuse the
 * stop (exit code 2 + stderr JSON naming `LOCAL-COMMIT-BEFORE-EXIT`; a `Dirty paths (N):` header
 * with the full dirty count, up to 50 listed paths, and — when there are more than 50 — a
 * trailing `… and X more` line with the remaining count) so the subagent commits before
 * exiting. Post-merge cleanup that force-removes worktrees can no longer destroy uncommitted
 * work silently.
 *
 * Interactive sessions awaiting commit authorization set `DEVLOOPS_COMMIT_AUTH_PENDING=1` (an
 * opt-in operator/coordination-path signal, like `DEVLOOPS_MAIN_AGENT_READONLY`) and are
 * exempt — they legitimately hold uncommitted work while waiting for the operator.
 *
 * Editing roles (`developer`/`fixer`/`docs`/`quality`) stay fully enforced: an editing
 * sub-delegate commits its own work before exit, so a dirty exit is a real defect. There is no
 * "LOCAL EDITS ONLY: no commit" orchestrator-owned-commit split — that pattern deadlocked an
 * editing subagent under a task-scoped no-commit instruction when the orchestrator could not set a
 * per-dispatch env var (#1936), so it was removed along with its `DEVLOOPS_ORCHESTRATOR_OWNS_COMMIT`
 * exemption (#1786). An orchestrator that wants one consolidated commit performs the edits itself.
 *
 * A cwd outside `tmp/worktrees/` is unaffected; a clean worktree stops normally; a non-git cwd
 * (git unavailable) allows the stop (nothing to guard).
 *
 * The SubagentStop block contract differs from PreToolUse: block = exit code 2 with the reason
 * as JSON on stderr (fed back to the subagent so it continues), allow = exit 0.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  decideSubagentStopGuard,
  DEVLOOPS_COMMIT_AUTH_PENDING_VAR,
} from "./_hook-decisions.mjs";
import { readHookInput } from "./_hook-io.mjs";

export function evaluateSubagentStop(input, {
  env = process.env,
  cwdFallback = process.cwd(),
  execFileSyncImpl = execFileSync,
} = {}) {
  const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : cwdFallback;
  // Claude exposes `agent_type` inside a subagent (null in the main agent). A read-only role
  // (judge/review) is exempt (#1925) — see decideSubagentStopGuard / READONLY_SUBAGENT_ROLES.
  const agentType = typeof input?.agent_type === "string" ? input.agent_type : null;
  const pendingCommitAuthorization = env[DEVLOOPS_COMMIT_AUTH_PENDING_VAR] === "1";

  let porcelain = "";
  try {
    // Bounded: a stalled `git status` (slow/networked FS, held index lock) must not hang the
    // subagent stop. On timeout git is killed and execFileSync throws → caught → porcelain=""
    // → fail-safe allow (better than blocking the exit with no message).
    // maxBuffer is raised to 10MB: the Node default (1MB) makes execFileSync throw once
    // `git status --porcelain` output crosses that size, which the catch would turn into a
    // fail-safe allow — defeating the guard exactly when the most work is at risk.
    porcelain = execFileSyncImpl("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    // Not a git repo / git unavailable / status timed out — nothing to guard, allow the stop.
    porcelain = "";
  }

  return decideSubagentStopGuard({ cwd, porcelain, pendingCommitAuthorization, agentType });
}

export function runSubagentStopHook({
  input = readHookInput(),
  env = process.env,
  stderr = process.stderr,
} = {}) {
  const decision = evaluateSubagentStop(input, { env });
  if (decision.decision === "block") {
    stderr.write(JSON.stringify({ decision: "block", reason: decision.reason }) + "\n");
    return 2;
  }
  // Surface an advisory reason for an allowed stop without blocking it.
  if (decision.advisory && typeof decision.reason === "string") {
    stderr.write(JSON.stringify({ decision: "allow", advisory: true, reason: decision.reason }) + "\n");
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runSubagentStopHook();
}
