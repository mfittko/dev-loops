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

  // Config-driven loop-state → board-column mapping (#793, AC1/AC3). Loaded
  // once per run; resolves logical columns to configured display names, with
  // the AC1 defaults when no `queue.statusColumns`/`queue.stateColumnMap` is set.
  const stateColumnMap = loadStateColumnMap(repoRoot);
  const columnFor = (loopState) => boardColumnForLoopState(loopState, stateColumnMap);

  // Optional board-aware ordering: fetch Next Up order before processing.
  // Fail-open: if the board is unreachable, orderHint stays empty and the
  // driver falls back to the existing queue order.
  const ordering = opts.useBoardOrdering !== false && !allDone(queue)
    ? await resolveNextUpOrder(repo, repoRoot, opts.env ?? process.env, opts.queueBoardSyncDependencies ?? {})
    : { ok: true, order: [], reason: "board ordering disabled or queue idle" };
  const orderHint = ordering.ok ? ordering.order : [];

  let autoFiledCount = 0;
  const results = [];
  let incomplete = false;

  while (!allDone(queue)) {
    const entry = nextReadyEntry(queue, opts.reDispatchMaxRetries, orderHint);
    if (!entry) {
      const remaining = queue.entries.filter(
        (e) => e.status !== "done" && e.status !== "blocked" && e.status !== "failed"
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

    // Entry has been picked up and is actively running: local implementation.
    await recordBoardSync(syncBoardStatus(
      repo,
      repoRoot,
      entry.target,
      columnFor("local_implementation_active"),
      opts.env ?? process.env,
      boardSyncDeps,
    ));

    try {
      const entryResult = opts.runEntry
        ? await opts.runEntry(entry, repo, opts)
        : { ok: true, pr: null };

      if (entryResult.ok) {
        if (entryResult.pr) {
          await doTransition(entry, "waiting_review", queue, repoRoot, opts, { pr: entryResult.pr });
          await doTransition(entry, "gates_passing", queue, repoRoot, opts);
          if (opts.mergeAuthorized) {
            await doTransition(entry, "merging", queue, repoRoot, opts);
            await doTransition(entry, "done", queue, repoRoot, opts, { retrospectiveWritten: true });
            await recordBoardSync(syncBoardStatus(repo, repoRoot, entry.target, columnFor("merged"), opts.env ?? process.env, boardSyncDeps));
          } else {
            // PR is up with gates passing but merge is not authorized: the work
            // is awaiting final approval/merge. Map to the final-approval column
            // (configured "Ready for Review" if present, else "In Progress").
            await recordBoardSync(syncBoardStatus(repo, repoRoot, entry.target, columnFor("final_approval_ready"), opts.env ?? process.env, boardSyncDeps));
          }
        } else {
          await doTransition(entry, "done", queue, repoRoot, opts);
          await recordBoardSync(syncBoardStatus(repo, repoRoot, entry.target, columnFor("done"), opts.env ?? process.env, boardSyncDeps));
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
