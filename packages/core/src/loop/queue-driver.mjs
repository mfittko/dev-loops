/**
 * Sequential queue driver — iterates entries, calls startup resolver per entry,
 * routes through existing dev-loop strategies.
 */

import {
  readQueue,
  writeQueue,
  transitionEntry,
  snapshotEntry,
  nextReadyEntry,
  allDone,
  RECOVERABLE_FAILURES,
  appendBugIssue,
} from "./queue-state.mjs";
import {
  syncBoardStatus,
  nonSuccessBoardColumn,
  boardColumnForLoopState,
  loadStateColumnMap,
} from "./queue-board-sync.mjs";
import { resolveNextUpOrder } from "./queue-board-ordering.mjs";

export const DEFAULT_QUEUE_DRIVER_OPTIONS = {
  mergeAuthorized: false,
  reDispatchMaxRetries: 1,
  maxAutoFiledIssues: 10,
  env: process.env,
};

export function classifyFailure(error) {
  if (!error) return "unknown";
  const msg = typeof error === "string" ? error : error.message ?? "";
  if (/parse|acceptance.report|unexpected token|JSON|malformed/i.test(msg)) return "acceptance_report_parse_failure";
  if (/round.cap|max.*round|review.*limit/i.test(msg)) return "round_cap_reached";
  if (/timeout|timed.out|watch.*expired/i.test(msg)) return "timeout";
  if (/blocked|human.*comment|needs.*decision|needs.*user/i.test(msg)) return "blocked_needs_user_decision";
  if (/ci.*fail|check.*fail|build.*fail|test.*fail/i.test(msg)) return "ci_failure";
  return "unknown";
}

export function isRecoverable(failureKind) {
  return RECOVERABLE_FAILURES.has(failureKind);
}

async function doTransition(entry, to, queue, repoRoot, opts, metadata) {
  transitionEntry(entry, to, metadata);
  await writeQueue(repoRoot, queue);
  if (opts.onTransition) opts.onTransition(to, entry, queue);
}

/**
 * Run the queue sequentially. Returns { ok, results, queue }.
 * ok is true only when every entry succeeded; blocked entries count as failure.
 */
export async function runQueue(repoRoot, repo, options = {}) {
  const opts = { ...DEFAULT_QUEUE_DRIVER_OPTIONS, ...options };
  const queue = await readQueue(repoRoot);

  // Data-integrity guard (#913): this driver is a deterministic ADAPTER over the
  // board, not the orchestration harness. Completion (`done` / move to Done) may
  // only ever REFLECT a real terminal signal supplied by an orchestrator via
  // `runEntry` (e.g. a merged PR). With no `runEntry` wired in the current
  // harness there is nothing that can produce a verifiable terminal state, so
  // the run MUST be a no-op: leave every entry and board column untouched and
  // report the reason. Previously the missing-orchestrator path fell back to a
  // fabricated `{ ok: true, pr: null }` per entry, which silently marked an
  // entire Next Up `done` and moved it to Done without any work happening.
  if (typeof opts.runEntry !== "function") {
    return {
      ok: true,
      noop: true,
      reason: "no-orchestrator",
      message:
        "queue run is a deterministic adapter with no orchestrator wired (no runEntry); " +
        "leaving board columns unchanged. Items move to Done only on a real terminal signal.",
      results: [],
      queue,
    };
  }

  // Config-driven loop-state → board-column mapping (#793, AC1/AC3). Loaded
  // once per run; resolves logical columns to configured display names, with
  // the AC1 defaults when no `queue.statusColumns`/`queue.stateColumnMap` is set.
  const stateColumnMap = loadStateColumnMap(repoRoot);
  const columnFor = (loopState) => boardColumnForLoopState(loopState, stateColumnMap);

  // Per-item dedup: a single run may resolve consecutive loop states to the
  // same display column (e.g. implementation → final_approval_ready both
  // default to "In Progress"). Skip the redundant board write/API call when the
  // target column is unchanged for that item; a genuinely different column
  // (e.g. a configured "Ready for Review") still syncs. (#793 round-1 #1)
  const lastSyncedColumn = new Map();

  // Next Up is the NORMATIVE, fail-closed pickup source (#1091). When no
  // explicit --issue/--pr target is given and a board is configured, the driver
  // picks ONLY entries whose target is in Next Up, by POSITION ascending;
  // entries absent from Next Up are never auto-picked. It NEVER falls back to
  // Backlog or to the non-board local queue order.
  //
  // An explicit target (`opts.explicitTarget`) bypasses Next Up gating entirely
  // and remains authoritative — the item runs regardless of the board.
  const explicitTarget = opts.explicitTarget != null;
  const ordering = opts.useBoardOrdering !== false && !allDone(queue) && !explicitTarget
    ? await resolveNextUpOrder(repo, repoRoot, opts.env ?? process.env, opts.queueBoardSyncDependencies ?? {})
    : { ok: true, configured: false, order: [], reason: "board ordering disabled, queue idle, or explicit target" };

  // (b) Board-query ERROR → surface it and stop. Do NOT fall back to Backlog
  // or local order (fail-closed). Distinct from an empty Next Up below.
  if (ordering.ok === false) {
    return {
      ok: false,
      stopped: true,
      reason: "board-query-error",
      message: `Next Up query failed (${ordering.reason}); refusing to fall back to Backlog/local order`,
      error: ordering.reason ?? "board query failed",
      results: [],
      queue,
      ordering,
    };
  }

  // Board-gated only when a board is configured and no explicit target overrides.
  const boardGated = ordering.configured === true && !explicitTarget;
  const orderHint = ordering.order;
  const allowedTargets = boardGated ? new Set(orderHint) : null;

  // (a) Empty Next Up (successful query, zero items) → fail CLOSED: idle/stop
  // with an actionable, machine-readable outcome. Never pull from Backlog.
  if (boardGated && orderHint.length === 0) {
    return {
      ok: true,
      idle: true,
      reason: "next-up-empty",
      message: "queue empty — prioritize Backlog items into Next Up",
      results: [],
      queue,
      ordering,
    };
  }

  let autoFiledCount = 0;
  const results = [];
  let incomplete = false;

  while (!allDone(queue)) {
    const entry = nextReadyEntry(queue, opts.reDispatchMaxRetries, orderHint, allowedTargets);
    if (!entry) {
      // When board-gated, entries absent from Next Up are intentionally NOT
      // picked (and are not "blocked by deps") — only unfinished Next Up members
      // count toward an incomplete verdict.
      const remaining = queue.entries.filter(
        (e) => e.status !== "done" && e.status !== "blocked" && e.status !== "failed"
             && (!allowedTargets || allowedTargets.has(e.target))
      );
      if (remaining.length > 0) {
        incomplete = true;
        results.push({
          target: null, ok: false,
          error: `Queue incomplete: ${remaining.length} entries blocked by unmet dependencies`,
          pendingTargets: remaining.map((e) => e.target),
        });
      }
      break;
    }

    const wasFailed = entry.status === "failed";
    if (wasFailed) {
      entry.retryCount = (entry.retryCount ?? 0) + 1;
      await doTransition(entry, "queued", queue, repoRoot, opts);
    }
    await doTransition(entry, "running", queue, repoRoot, opts);

    const boardSync = [];
    const boardSyncDeps = opts.queueBoardSyncDependencies ?? {};
    const recordBoardSync = async (promise) => {
      const r = await promise;
      boardSync.push(r);
      return r;
    };
    // Sync a target to a column, short-circuiting (no API call) when the column
    // is unchanged from the last sync for the same item in this run.
    const syncColumn = async (target, column) => {
      if (lastSyncedColumn.get(target) === column) {
        return recordBoardSync(Promise.resolve({
          ok: true, skipped: true, reason: "column unchanged",
        }));
      }
      const r = await recordBoardSync(syncBoardStatus(
        repo, repoRoot, target, column, opts.env ?? process.env, boardSyncDeps,
      ));
      // Only remember the column when the move actually landed, so a fail-open
      // skip does not suppress a later retry to the same column.
      if (r.ok && r.skipped !== true) lastSyncedColumn.set(target, column);
      return r;
    };

    // Entry has been picked up and is actively running: implementation phase
    // (real lifecycle state, lifecycle-state.mjs LIFECYCLE_STATE.IMPLEMENTATION).
    await syncColumn(entry.target, columnFor("implementation"));

    try {
      // runEntry is guaranteed a function here (guarded at function entry):
      // the adapter never fabricates a terminal result for an undispatched item.
      const entryResult = await opts.runEntry(entry, repo, opts);

      if (entryResult.ok) {
        if (entryResult.pr) {
          await doTransition(entry, "waiting_review", queue, repoRoot, opts, { pr: entryResult.pr });
          await doTransition(entry, "gates_passing", queue, repoRoot, opts);
          if (opts.mergeAuthorized) {
            await doTransition(entry, "merging", queue, repoRoot, opts);
            await doTransition(entry, "done", queue, repoRoot, opts, { retrospectiveWritten: true });
            await syncColumn(entry.target, columnFor("done"));
          } else {
            // PR is up with gates passing but merge is not authorized: the work
            // is awaiting final approval/merge. Map to the final-approval column
            // (configured "Ready for Review" if present, else "In Progress").
            // Deduped: when this resolves to the same column already synced for
            // this item, no extra board write/API call is made.
            await syncColumn(entry.target, columnFor("final_approval_ready"));
          }
        } else {
          await doTransition(entry, "done", queue, repoRoot, opts);
          await syncColumn(entry.target, columnFor("done"));
        }
        results.push({ target: entry.target, ok: true, entry: snapshotEntry(entry), boardSync });
      } else {
        throw new Error(entryResult.error || "Entry failed");
      }
    } catch (err) {
      const fallbackColumn = nonSuccessBoardColumn(repoRoot, "Backlog");
      await recordBoardSync(syncBoardStatus(repo, repoRoot, entry.target, fallbackColumn, opts.env ?? process.env, boardSyncDeps));

      const failureKind = classifyFailure(err);
      const recoverable = isRecoverable(failureKind);

      if (recoverable && (entry.retryCount ?? 0) < opts.reDispatchMaxRetries) {
        await doTransition(entry, "failed", queue, repoRoot, opts, {
          failureReason: err.message, failureKind,
        });
        results.push({
          target: entry.target, ok: false, recoverable: true,
          failureKind, entry: snapshotEntry(entry), boardSync,
        });
      } else {
        await doTransition(entry, "blocked", queue, repoRoot, opts, {
          failureReason: err.message, failureKind,
        });
        if (autoFiledCount < opts.maxAutoFiledIssues && failureKind !== "blocked_needs_user_decision") {
          appendBugIssue(queue, entry.target + 1000, entry.target);
          autoFiledCount++;
        }
        results.push({
          target: entry.target, ok: false, recoverable: false,
          failureKind, entry: snapshotEntry(entry), boardSync,
        });
      }
    }
  }

  const allOk = results.every((r) => r.ok !== false) && !incomplete;
  return { ok: allOk, results, queue, ordering };
}
