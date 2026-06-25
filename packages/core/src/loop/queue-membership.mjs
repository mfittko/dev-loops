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
 *   - `null`            — there is pending work; the caller should run the queue.
 *   - "queue_empty"      — board not configured and the local queue is empty
 *                          (legacy "Queue is empty" message).
 *   - "board_empty"      — board IS configured but, after reconcile, there is no
 *                          pending work (board Next Up empty / nothing to do).
 *                          Distinct from the misleading generic empty case.
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
 * @returns {Promise<{queue:object, added:number[], boardConfigured:boolean, emptiness:(null|"queue_empty"|"board_empty"), reason:(string|null)}>}
 */
export async function reconcileBoardMembership(repoRoot, repo, queue, deps = {}) {
  const loadConfig = deps.loadBoardConfig ?? loadBoardConfig;
  const resolveOrder = deps.resolveNextUpOrder ?? resolveNextUpOrder;
  const persist = deps.writeQueue ?? writeQueue;
  const env = deps.env ?? process.env;
  const log = typeof deps.log === "function" ? deps.log : (msg) => console.error(msg);

  let boardConfigured = false;
  try {
    boardConfigured = Boolean(loadConfig(repoRoot)?.enabled);
  } catch (err) {
    // Config read errors must not crash the queue; treat as unconfigured.
    log(`[queue-membership] board config read failed (fail-open): ${err?.message ?? err}`);
    boardConfigured = false;
  }

  let added = [];
  let reason = null;

  if (boardConfigured) {
    let nextUp = [];
    try {
      const result = await resolveOrder(repo, repoRoot, env, deps.boardDependencies ?? {});
      reason = result?.reason ?? null;
      nextUp = Array.isArray(result?.order) ? result.order : [];
    } catch (err) {
      // resolveNextUpOrder is itself fail-open, but guard anyway: a board
      // resolution error falls back to the local queue without crashing.
      reason = err?.message ?? "board resolution failed";
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
    emptiness = boardConfigured ? "board_empty" : "queue_empty";
  }

  return { queue, added, boardConfigured, emptiness, reason };
}
