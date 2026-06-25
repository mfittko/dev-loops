/**
 * Queue membership reconciliation (issue #864).
 *
 * A configured GitHub Projects board is the authoritative source of queue
 * MEMBERSHIP (which issues to work) and ordering — not just status. Before a
 * queue run, this module folds the board's "Next Up" items into the local
 * `.pi/dev-loop-queue.json` entries so the board drives membership, and reports
 * a clear, non-misleading emptiness verdict.
 *
 * This is the testable orchestration seam used by `scripts/loop/run-queue.mjs`.
 * Board config loading, Next Up resolution, and queue persistence are all
 * injectable so the policy can be exercised without GitHub or the filesystem.
 */

import { loadBoardConfig } from "./queue-board-sync.mjs";
import { resolveNextUpOrder } from "./queue-board-ordering.mjs";
import { reconcileEntriesFromBoard, writeQueue, pendingEntries } from "./queue-state.mjs";

/**
 * Reconcile a configured board's Next Up membership into the queue, then
 * classify emptiness.
 *
 * Behavior:
 *   - Board NOT configured: no reconcile. Emptiness is judged purely on the
 *     local queue (preserving the legacy "Queue is empty" behavior).
 *   - Board configured: resolve Next Up targets and reconcile them in. If the
 *     resolver fails-open (returns no targets) the board membership simply
 *     contributes nothing; we never crash. Newly added targets are persisted
 *     via `writeQueue`.
 *
 * Emptiness verdict (`emptiness`):
 *   - `null`              — there is pending work; the caller should run the queue.
 *   - "queue_empty"       — board not configured and the local queue is empty
 *                           (legacy "Queue is empty" message).
 *   - "board_empty"       — board IS configured, Next Up resolved successfully
 *                           (reason == null) but is genuinely empty, and there is
 *                           no pending local work. Distinct from the misleading
 *                           generic empty case.
 *   - "board_unavailable" — board IS configured but Next Up resolution failed
 *                           (fail-open: empty order WITH a non-null reason) and
 *                           the local queue had no pending work to fall back to.
 *                           This must NOT be reported as "board_empty" — the
 *                           board may well have items we simply could not read.
 *
 * @param {string} repoRoot
 * @param {string} repo - "owner/name"
 * @param {{version:number, entries:Array}} queue
 * @param {object} [deps]
 * @param {(repoRoot:string)=>{enabled:boolean}} [deps.loadBoardConfig]
 * @param {(repo:string, repoRoot:string, env:object, d:object)=>Promise<{ok:boolean, order:number[], reason:?string}>} [deps.resolveNextUpOrder]
 * @param {(repoRoot:string, queue:object)=>Promise<void>} [deps.writeQueue]
 * @param {object} [deps.env]
 * @param {(msg:string)=>void} [deps.log]
 * @param {object} [deps.boardDependencies] - forwarded to resolveNextUpOrder.
 * @returns {Promise<{queue:object, added:number[], boardConfigured:boolean, emptiness:(null|"queue_empty"|"board_empty"|"board_unavailable"), reason:(string|null)}>}
 */
export async function reconcileBoardMembership(repoRoot, repo, queue, deps = {}) {
  const loadConfig = deps.loadBoardConfig ?? loadBoardConfig;
  const resolveOrder = deps.resolveNextUpOrder ?? resolveNextUpOrder;
  const persist = deps.writeQueue ?? writeQueue;
  const env = deps.env ?? process.env;
  const log = typeof deps.log === "function" ? deps.log : (msg) => console.error(msg);

  let boardConfigured = false;
  try {
    const config = loadConfig(repoRoot);
    boardConfigured = Boolean(config?.enabled);
    // loadBoardConfig does not throw on read/parse failures; it reports them
    // via `{ enabled: false, reason: ... }`. Surface that reason so a genuine
    // config read/parse error is visible instead of being silently treated as
    // "board not configured". The ordinary "board not configured" case carries
    // no reason and must stay quiet.
    if (!boardConfigured && config?.reason) {
      log(`[queue-membership] board config unavailable (fail-open): ${config.reason}`);
    }
  } catch (err) {
    // Config read errors must not crash the queue; treat as unconfigured.
    log(`[queue-membership] board config read failed (fail-open): ${err?.message ?? err}`);
    boardConfigured = false;
  }

  let added = [];
  let reason = null;
  // True when the board is configured but Next Up could not be resolved: the
  // resolver is fail-open, so this surfaces as an empty order WITH a non-null
  // reason (or a thrown error caught below). We must not confuse this with a
  // genuinely empty Next Up (empty order AND reason == null).
  let resolutionFailed = false;

  if (boardConfigured) {
    let nextUp = [];
    try {
      const result = await resolveOrder(repo, repoRoot, env, deps.boardDependencies ?? {});
      reason = result?.reason ?? null;
      nextUp = Array.isArray(result?.order) ? result.order : [];
      // Fail-open contract: an empty order paired with a non-null reason means
      // resolution failed (API error, board lookup failure, etc.) — NOT that the
      // board's Next Up is genuinely empty.
      if (nextUp.length === 0 && reason != null) {
        resolutionFailed = true;
        log(`[queue-membership] Next Up resolution failed (fail-open), using local queue: ${reason}`);
      }
    } catch (err) {
      // resolveNextUpOrder is itself fail-open, but guard anyway: a board
      // resolution error falls back to the local queue without crashing.
      reason = err?.message ?? "board resolution failed";
      resolutionFailed = true;
      log(`[queue-membership] Next Up resolution failed (fail-open), using local queue: ${reason}`);
      nextUp = [];
    }

    if (nextUp.length > 0) {
      const outcome = reconcileEntriesFromBoard(queue, nextUp);
      added = outcome.added;
      if (added.length > 0) {
        log(`[queue-membership] added ${added.length} entr${added.length === 1 ? "y" : "ies"} from board Next Up: ${added.join(", ")}`);
        try {
          await persist(repoRoot, queue);
        } catch (err) {
          // A write failure should not crash the run; entries still drive this
          // in-memory run, they just are not persisted for the next invocation.
          log(`[queue-membership] failed to persist reconciled queue (continuing in-memory): ${err?.message ?? err}`);
        }
      }
    }
  }

  const pending = pendingEntries(queue);
  let emptiness = null;
  if (pending.length === 0) {
    if (!boardConfigured) {
      emptiness = "queue_empty";
    } else if (resolutionFailed) {
      // Board configured but we could not read Next Up and the local queue is
      // empty: the board may have items we simply failed to fetch. Report a
      // distinct verdict instead of the misleading "board_empty".
      emptiness = "board_unavailable";
    } else {
      // Board configured, Next Up resolved cleanly (reason == null) and empty.
      emptiness = "board_empty";
    }
  }

  return { queue, added, boardConfigured, emptiness, reason };
}
