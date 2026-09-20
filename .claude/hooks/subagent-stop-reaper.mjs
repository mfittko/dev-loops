#!/usr/bin/env node
/**
 * SubagentStop background-shell reaper (#2065).
 *
 * Under the Claude Code single-agent harness there is no async wake, so a backgrounded wait/poll
 * shell the agent launched (`… &`, a `while … sleep … done` loop, a backgrounded
 * `probe-copilot-review.mjs`) is never joined and never exits — it orphans past the agent stop.
 * Across the observed runs several such shells accumulated per completed loop, one running ~11h.
 *
 * Prevention is the root-cause fix: the PreToolUse Bash-gate (`decideBashGate` /
 * `commandContainsDetachedWaitTool`) denies backgrounding a wait/probe helper for the coordinator
 * and every subagent. This hook is the safety net that reaps whatever slipped through, before the
 * stop is allowed.
 *
 * Scope (mirrors `ui-review-teardown`'s `process.kill(-pgid)` + win32 fail-closed pattern):
 *   - Verifiable ownership boundary: it reaps ONLY process-GROUP LEADERS (a process whose own pgid
 *     equals its pid — i.e. a real detached background job group) that share the reaper's SESSION,
 *     minus the reaper itself and the session leader (the agent/shell). Because every reaped pid
 *     leads its OWN group, `process.kill(-pid)` signals only that job's group — never a foreground
 *     sibling or another process that merely shares the reaper's group. It never touches unrelated
 *     processes, other sessions, or git/worktree state (the uncommitted-work guard owns that).
 *   - win32 fails closed: Node cannot signal a process group there, so the reaper skips rather than
 *     misfire.
 *   - The reaper NEVER blocks the stop — it always exits 0. Blocking the stop is the
 *     uncommitted-work guard's job; this hook only cleans up.
 *
 * The decision logic (platform gate, positive-integer/self/ancestor rejection, empty=no-op) lives
 * in the pure `decideSubagentStopReap` in the vendored `./_hook-decisions.mjs` bundle so it is
 * unit-testable without spawning processes. Discovery and signalling are injectable seams so the
 * behavior is testable without real background shells.
 *
 * ponytail: session + group-leader enumeration via `ps`, no PID registry (a PID registry / general
 * job supervisor is an explicit #2065 non-goal). A background job that is NOT its own group leader
 * (e.g. a shell that backgrounded a child without job control) is conservatively left alone → the
 * reaper no-ops rather than risk a foreground sibling; prevention is the real fix, this is the net.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { decideSubagentStopReap } from "./_hook-decisions.mjs";
import { readHookInput } from "./_hook-io.mjs";

/**
 * Best-effort discovery of the detached background job groups THIS agent left running: resolve the
 * reaper's own SESSION id (the ownership boundary a background job the agent started shares), then
 * enumerate every process and keep only the process-GROUP LEADERS (pid === pgid) in that session,
 * dropping the reaper itself and the session leader (the agent/shell). Restricting to group leaders
 * is the verifiable per-job boundary: each returned pid leads its own group, so a later
 * `kill(-pid)` signals only that job's group, never a foreground sibling that merely shares the
 * reaper's group. A `ps` failure or an unresolvable session yields an empty set (fail-safe no-op).
 */
export function discoverOwnBackgroundShells({ selfPid = process.pid, execFileSyncImpl = execFileSync } = {}) {
  let sid = null;
  try {
    sid = Number(execFileSyncImpl("ps", ["-o", "sess=", "-p", String(selfPid)], { encoding: "utf8", timeout: 4000 }).trim());
  } catch {
    return { sid: null, pids: [] };
  }
  if (!Number.isInteger(sid) || sid <= 1) return { sid: null, pids: [] };
  let out = "";
  try {
    out = execFileSyncImpl("ps", ["-A", "-o", "pid=,pgid=,sess="], { encoding: "utf8", timeout: 4000 });
  } catch {
    return { sid, pids: [] };
  }
  const pids = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const pgid = Number(m[2]);
    const sess = Number(m[3]);
    // Own the process only when: same session as the reaper; a process-GROUP LEADER (pid === pgid,
    // a real detached job group); not the reaper itself; and not the session leader (pid === sid).
    if (sess === sid && pid === pgid && pid > 1 && pid !== selfPid && pid !== sid) {
      pids.push(pid);
    }
  }
  return { sid, pids };
}

/**
 * Signal a background shell's process GROUP (`-pid`), falling back to the bare pid when the group
 * signal is not deliverable — the same shape as `ui-review-teardown`'s `signalProcess`. Refuses a
 * non-positive-integer pid outright (a group-kill on 0/-1 would be catastrophic).
 */
export function signalGroup(pid, { killImpl = process.kill } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error(`refusing to signal non-positive-integer pid: ${pid}`);
  }
  try {
    killImpl(-pid, "SIGTERM");
  } catch {
    killImpl(pid, "SIGTERM");
  }
}

export function runSubagentStopReaper({
  input = readHookInput(),
  stderr = process.stderr,
  platform = process.platform,
  selfPid = process.pid,
  discover = discoverOwnBackgroundShells,
  signal = signalGroup,
} = {}) {
  // `input` is accepted for parity with the other SubagentStop hooks and to keep stdin drained;
  // discovery is session/group-leader based, so the payload carries nothing the reaper needs today.
  void input;
  const { sid, pids } = discover({ selfPid });
  const decision = decideSubagentStopReap({
    platform,
    backgroundPids: pids,
    selfPid,
    protectedPids: sid ? [sid] : [], // never signal the session leader (the agent/shell)
  });
  if (decision.decision === "reap") {
    for (const pid of decision.pids) {
      try {
        signal(pid);
      } catch {
        // Best-effort: a race where the shell already exited (ESRCH) or a bad pid is non-fatal —
        // the reaper never blocks the stop.
      }
    }
  }
  // Surface an advisory for a reap/skip so the action is visible; a no-op stays silent. The stop
  // is ALWAYS allowed (exit 0) — the reaper is a cleanup net, never a stop blocker.
  if (decision.decision !== "noop" && typeof decision.reason === "string") {
    stderr.write(JSON.stringify({ decision: "allow", advisory: true, reason: decision.reason }) + "\n");
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runSubagentStopReaper();
}
