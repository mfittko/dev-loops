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
 * Scope (mirrors `ui-review-teardown`'s `process.kill(-pgid)` group-signal + win32 fail-closed
 * pattern, but — see `signalGroup` below — deliberately drops its positive-pid fallback):
 *   - Verifiable ownership boundary: session + group-leader scoping (below) narrows candidates,
 *     but is NOT sufficient ownership proof by itself — a foreground job-control job (`sleep 300 &`
 *     typed at a shell) or an unrelated detached process the agent started on purpose (e.g. the
 *     `ui-review` skill's server, spawned with `{ detached: true }`) is ALSO a group leader in the
 *     SAME session. The reaper therefore also requires the leader's COMMAND to match the
 *     wait/probe helper signature (`commandInvokesWaitProbeHelper` in
 *     `../../packages/core/src/loop/bash-command-classify.mjs`, vendored into
 *     `./_bash-command-classify.mjs`) — the exact set of tools the PreToolUse Bash-gate denies
 *     backgrounding (`probe-copilot-review`/`wait-pr-checks`/`detect-copilot-loop-state`/
 *     `run-watch-cycle` .mjs, `gh run watch`, `dev-loops`/`dev-loops-run` watch-cycle/probe-copilot, a
 *     `while|until … sleep … (gh|loop-state)` poll loop). A group leader that is session-scoped but
 *     does NOT match this signature (the UI-review server, an ad-hoc foreground job) is left alone
 *     by construction — only a job whose OWN command is a wait/probe helper is reapable.
 *   - Because every reaped pid leads its OWN group, `process.kill(-pid)` signals only that job's
 *     group — never a foreground sibling or another process that merely shares the reaper's group.
 *     It never touches unrelated processes, other sessions, or git/worktree state (the
 *     uncommitted-work guard owns that).
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

import { commandInvokesWaitProbeHelper } from "./_bash-command-classify.mjs";
import { decideSubagentStopReap } from "./_hook-decisions.mjs";
import { readHookInput } from "./_hook-io.mjs";

/**
 * Best-effort discovery of the detached background job groups THIS agent left running: resolve the
 * reaper's own SESSION id (the ownership boundary a background job the agent started shares), then
 * enumerate every process and keep only the process-GROUP LEADERS (pid === pgid) in that session,
 * dropping the reaper itself and the session leader (the agent/shell) — AND whose COMMAND matches
 * the wait/probe helper signature (`commandInvokesWaitProbeHelper`), the verifiable ownership
 * boundary: session + group-leader scoping alone would also catch a foreground job-control job or
 * an unrelated detached process (e.g. the `ui-review` server) sharing the same session, so a
 * leader that does not itself invoke a wait/probe helper is left alone. Restricting to matching
 * group leaders is the per-job boundary: each returned pid leads its own group, so a later
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
    // `command=` is the trailing field and may itself contain spaces — split with a limited
    // field count (3 numeric fields + the rest of the line as command) rather than a fixed-width
    // token split, so a multi-word command line is captured whole, not truncated at its first space.
    out = execFileSyncImpl("ps", ["-A", "-o", "pid=,pgid=,sess=,command="], { encoding: "utf8", timeout: 4000 });
  } catch {
    return { sid, pids: [] };
  }
  const pids = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const pgid = Number(m[2]);
    const sess = Number(m[3]);
    const command = m[4];
    // Own the process only when: same session as the reaper; a process-GROUP LEADER (pid === pgid,
    // a real detached job group); not the reaper itself; not the session leader (pid === sid); AND
    // its own command matches the wait/probe helper signature — the verifiable ownership boundary
    // that makes an unrelated group leader (a foreground job, a detached UI-review server, …)
    // unreapable by construction.
    if (sess === sid && pid === pgid && pid > 1 && pid !== selfPid && pid !== sid && commandInvokesWaitProbeHelper(command)) {
      pids.push(pid);
    }
  }
  return { sid, pids };
}

/**
 * Signal a background shell's process GROUP (`-pid`) ONLY — SIGTERM, best-effort. Refuses a
 * non-positive-integer pid outright (a group-kill on 0/-1 would be catastrophic).
 *
 * Deliberately DROPS the positive-pid fallback that `ui-review-teardown`'s `signalProcess` keeps:
 * `ui-review-teardown` owns a known live server pid it itself spawned moments earlier, with no
 * reuse window, so falling back to `kill(pid)` there still reaches the right process when the
 * group signal fails. This reaper's pids instead come from a `ps` scan
 * (`discoverOwnBackgroundShells`) across a TOCTOU window between discovery and signalling here —
 * if the group has already exited (ESRCH) or the group signal is refused (EPERM) by the time this
 * runs, the positive pid may since have been reused by an unrelated process, so a `kill(pid)`
 * fallback could SIGTERM a process the agent never started, breaking the reaper's "never touches
 * unrelated processes" guarantee. Swallow ESRCH/EPERM/any other error and leave it: the group is
 * either already gone or not ours, and the reaper never blocks the stop regardless (best-effort
 * cleanup only, per the module doc above).
 */
export function signalGroup(pid, { killImpl = process.kill } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error(`refusing to signal non-positive-integer pid: ${pid}`);
  }
  try {
    killImpl(-pid, "SIGTERM");
  } catch {
    // Best-effort: the group is already gone or not ours to signal — never fall back to a
    // positive-pid kill (see doc above); leave it alone.
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
