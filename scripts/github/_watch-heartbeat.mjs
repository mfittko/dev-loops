/** Maximum interval between heartbeat outputs during watch delays.
 *  Must be shorter than pi-subagents default needsAttentionAfterMs (60s). */
export const WATCH_HEARTBEAT_MS = 45_000; // 45 seconds

/**
 * Sleep `pollDelayMs` in WATCH_HEARTBEAT_MS chunks, emitting a stderr
 * watch_heartbeat between chunks (never after the final chunk). Shared by the
 * PR-CI, commit-CI, and Copilot-activity watch loops so heartbeat cadence/shape
 * stay identical. Scheduling (attempt budget, poll-delay formula, baseline
 * capture) stays caller-owned — this helper only performs the chunked delay.
 *
 * `onHeartbeat` runs alongside each heartbeat (best-effort, caller-scoped side
 * effect — e.g. the PR loop's runner-lease refresh). A throw/rejection from it
 * is a caller-side side-effect failure, not a watch failure, so it is swallowed
 * and can never abort the watch loop.
 */
export async function waitWithHeartbeat(
  pollDelayMs,
  { attempt, attemptBudget, watchStartedAtMs, timeoutMs, now, delayImpl, onHeartbeat },
) {
  let remainingMs = pollDelayMs;
  while (remainingMs > 0) {
    const chunkMs = Math.min(WATCH_HEARTBEAT_MS, remainingMs);
    await delayImpl(chunkMs);
    remainingMs -= chunkMs;
    if (remainingMs > 0) {
      process.stderr.write(
        JSON.stringify({
          ok: true,
          type: "watch_heartbeat",
          elapsedMs: now() - watchStartedAtMs,
          totalBudgetMs: timeoutMs,
          poll: attempt,
          maxPolls: attemptBudget,
        }) + "\n",
      );
      if (onHeartbeat) {
        try {
          await onHeartbeat();
        } catch {
          // intentionally ignored
        }
      }
    }
  }
}
