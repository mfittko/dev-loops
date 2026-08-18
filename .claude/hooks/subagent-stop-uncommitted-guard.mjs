#!/usr/bin/env node
/**
 * SubagentStop uncommitted-work guard (#1619).
 *
 * `scripts/loop/cleanup-worktree.mjs` runs `git worktree remove --force` after a merge, so
 * uncommitted changes in a worktree are destroyed with no warning — the only data-loss gap in
 * the enforcement audit. `LOCAL-COMMIT-BEFORE-EXIT` existed only as prose; this hook makes it
 * mechanical: when a subagent stops with a dirty worktree under `tmp/worktrees/`, refuse the
 * stop (exit code 2 + stderr JSON naming `LOCAL-COMMIT-BEFORE-EXIT` and up to 50 dirty paths,
 * plus a summary line with the full count when there are more) so the subagent commits before
 * exiting. Post-merge cleanup that force-removes worktrees can no longer destroy uncommitted
 * work silently.
 *
 * Interactive sessions awaiting commit authorization set `DEVLOOPS_COMMIT_AUTH_PENDING=1` (an
 * opt-in operator/coordination-path signal, like `DEVLOOPS_MAIN_AGENT_READONLY`) and are
 * exempt — they legitimately hold uncommitted work while waiting for the operator.
 *
 * A cwd outside `tmp/worktrees/` is unaffected; a clean worktree stops normally; a non-git cwd
 * (git unavailable) allows the stop (nothing to guard).
 *
 * The SubagentStop block contract differs from PreToolUse: block = exit code 2 with the reason
 * as JSON on stderr (fed back to the subagent so it continues), allow = exit 0.
 */
import { execFileSync } from "node:child_process";

import { decideSubagentStopGuard, DEVLOOPS_COMMIT_AUTH_PENDING_VAR } from "./_hook-decisions.mjs";
import { readHookInput } from "./_hook-io.mjs";

const input = readHookInput();
const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd();

const pendingCommitAuthorization = process.env[DEVLOOPS_COMMIT_AUTH_PENDING_VAR] === "1";

let porcelain = "";
try {
  // Bounded: a stalled `git status` (slow/networked FS, held index lock) must not hang the
  // subagent stop. On timeout git is killed and execFileSync throws → caught → porcelain=""
  // → fail-safe allow (better than blocking the exit with no message).
  // maxBuffer is raised to 10MB: the Node default (1MB) makes execFileSync throw once
  // `git status --porcelain` output crosses that size, which the catch would turn into a
  // fail-safe allow — defeating the guard exactly when the most work is at risk. The e2e
  // fixture (test/contracts/claude-hooks-settings.test.mjs) trips the 1MB default at
  // ~4300+ dirty paths using its long (~245-byte) porcelain lines; real paths are much
  // shorter, so a real worktree needs far more entries to hit either bound. Beyond 10MB
  // (~43k+ such long-line paths) the fail-safe allow is the documented ceiling.
  porcelain = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", timeout: 5000, maxBuffer: 10 * 1024 * 1024 });
} catch {
  // Not a git repo / git unavailable / status timed out — nothing to guard, allow the stop.
  porcelain = "";
}

const decision = decideSubagentStopGuard({ cwd, porcelain, pendingCommitAuthorization });
if (decision.decision === "block") {
  process.stderr.write(JSON.stringify({ decision: "block", reason: decision.reason }) + "\n");
  process.exit(2);
}
// allow the stop
process.exit(0);
