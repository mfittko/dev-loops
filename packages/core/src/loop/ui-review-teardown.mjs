/**
 * Teardown + side-effect ledger orchestrator for the ui_review route (Stage 5).
 *
 * Terminal cleanup for a running-app review: stop the app booted in Stage 1,
 * drop the dev-DB rows the Stage-2 drive created, and remove the provisioned
 * worktree. The core safety property of this stage is that a side-effect ledger
 * is ALWAYS emitted — enumerating every migration applied, row created/dropped,
 * the worktree path, and any process left running — so nothing the loop touched
 * is ever silently orphaned, whether teardown succeeds, is skipped, or partially
 * fails.
 *
 * Two safety rails:
 *   - Destructive steps (row drops, worktree removal) run ONLY on explicit
 *     confirmation. Without it the destructive steps are skipped and the ledger
 *     records what remains. Stopping the app is a clean shutdown of a process
 *     the loop itself started, not a destructive mutation of persisted state, so
 *     it runs regardless of confirmation.
 *   - A failed kill/drop/removal is REPORTED in the ledger and the result's
 *     errors list, never swallowed.
 *
 * This module is PURE orchestration: the process kill, the row drop, and the
 * worktree removal are injected seams so it is fully testable without real side
 * effects. The thin CLI wires the real ones.
 *
 * Non-goals (explicit): NO rollback of the branch's dev-DB migrations by default
 * (they were applied to a dev DB; reversal is a separate explicit action — the
 * ledger records they were applied, not reverted). NO production teardown.
 */

/**
 * The honest row-drop reality: Stage 2 does NOT tag the dev-DB rows it creates
 * with a session id or row manifest. So unless an explicit row manifest is
 * handed in (and confirmed), this stage CANNOT know which rows to drop and MUST
 * NOT guess. When the drive ran mutating flows without a manifest, the ledger
 * reports rows "may remain (untagged)" rather than dropping anything.
 */

const ROW_STATUS = Object.freeze({
  DROPPED: "dropped",
  DROP_FAILED: "drop-failed",
  MAY_REMAIN_UNTAGGED: "may-remain-untagged",
  SKIPPED_UNCONFIRMED: "skipped-unconfirmed",
  NONE: "none",
});

const WORKTREE_STATUS = Object.freeze({
  REMOVED: "removed",
  REMOVE_FAILED: "remove-failed",
  SKIPPED_UNCONFIRMED: "skipped-unconfirmed",
  // No worktree path in the provision result at all. Distinct from
  // SKIPPED_UNCONFIRMED (which is the confirmation gate) so the ledger says WHY
  // removal did not run — a missing path, not a withheld confirmation.
  MISSING_PATH: "missing-path",
});

const PROCESS_STATUS = Object.freeze({
  STOPPED: "stopped",
  KILL_FAILED: "kill-failed",
  MAY_BE_RUNNING: "may-be-running",
  SKIPPED: "skipped",
});

/**
 * Did the Stage-2 drive potentially create dev-DB rows? Without row tagging this
 * is a coarse but honest signal: a drive that actually walked steps exercised
 * create/edit/upload interactions, so rows may have been created. A drive that
 * stopped before driving anything (e.g. auth failure) created nothing.
 */
function driveMayHaveCreatedRows(driveResult) {
  if (!driveResult || driveResult.stopped) return false;
  return Array.isArray(driveResult.steps) && driveResult.steps.length > 0;
}

/**
 * Run the teardown sequence and always return a result carrying the side-effect
 * ledger.
 *
 * @param {object} input
 * @param {object} input.provisionResult - Stage-1 result: `boot.pid` (app PID),
 *   `migrations` (applied count/detail), and `worktreePath`.
 * @param {object|null} [input.driveResult] - Stage-2 result: the rows-created
 *   signal (whether the drive walked mutating steps). Null when no drive ran.
 * @param {Array<object>|null} [input.rowManifest] - Explicit rows to drop, when
 *   a session tag/manifest is available. Absent/empty => untagged fallback.
 * @param {boolean} [input.confirm] - Explicit authorization for the destructive
 *   steps (row drop, worktree removal). Fail-safe: absent means NOT confirmed.
 * @param {boolean} [input.stopApp] - Stop the Stage-1 app (default true). This is
 *   a clean shutdown, NOT gated on confirmation.
 * @param {object} seams
 * @param {(a:{pid:number})=>Promise<{stopped:boolean,forced:boolean,detail:string,mayBeRunning?:boolean}>} seams.killProcess
 *   `mayBeRunning:true` marks a NOT-ATTEMPTED outcome (e.g. win32, where process-group
 *   signalling is unsupported) — mapped to MAY_BE_RUNNING (non-fatal), not KILL_FAILED.
 * @param {(a:{rows:Array<object>})=>Promise<{ok:boolean,dropped:number,detail:string}>} seams.dropRows
 * @param {(a:{worktreePath:string})=>Promise<{removed:string|null,ok:boolean,detail:string}>} seams.removeWorktree
 * @param {(msg:string)=>void} [seams.log]
 * @returns {Promise<{ok:boolean,confirmed:boolean,ledger:object,errors:string[],logs:string[]}>}
 */
export async function teardown(
  { provisionResult, driveResult = null, rowManifest = null, confirm = false, stopApp = true },
  { killProcess, dropRows, removeWorktree, log = () => {} } = {},
) {
  const logs = [];
  const errors = [];
  const record = (msg) => {
    logs.push(msg);
    log(msg);
  };
  const fail = (msg) => {
    errors.push(msg);
    record(msg);
  };

  const provision = provisionResult ?? {};
  // `worktreePath` is read from disk (trust boundary). A non-string (number,
  // object, array) must never reach `removeWorktree` — the CLI's cleanup path
  // calls `path.resolve(worktreePath)`, which throws on a non-string, breaking
  // the always-emit-ledger invariant. Coerce to a usable string or null here.
  const rawWorktreePath = provision.worktreePath ?? null;
  const worktreePath = typeof rawWorktreePath === "string" ? rawWorktreePath : null;
  const worktreePathMalformed = rawWorktreePath != null && typeof rawWorktreePath !== "string";
  const pid = provision.boot?.pid ?? null;
  const migrations = provision.migrations ?? { applied: 0, pending: 0, destructive: [], detail: "no provision migrations" };

  // 1. Stop the app (clean shutdown; NOT confirmation-gated). Uses the Stage-1
  //    boot PID. A missing OR unusable PID means we cannot stop it — the ledger
  //    reports it may still be running rather than guessing. `boot.pid` is read
  //    from disk (trust boundary), so anything that is not a positive integer
  //    (0, negative, NaN, float, string) is rejected here: passing it to the
  //    kill seam would let the CLI's process-group kill signal `process.kill(0)`
  //    (this loop's OWN group) or `process.kill(-1)` (every process).
  const usablePid = Number.isInteger(pid) && pid > 0;
  let processLedger;
  if (!stopApp) {
    processLedger = { pid: usablePid ? pid : null, status: PROCESS_STATUS.SKIPPED, forced: false, detail: "app stop skipped by request" };
    record(`app stop skipped (pid ${usablePid ? pid : "n/a"})`);
  } else if (!usablePid) {
    const detail = pid == null
      ? "no PID captured from Stage 1; process may still be running"
      : "no usable PID from Stage 1 (not a positive integer); process may still be running";
    processLedger = { pid: null, status: PROCESS_STATUS.MAY_BE_RUNNING, forced: false, detail };
    record(`app stop: ${detail}`);
  } else {
    // A seam that THROWS must still yield a fully-emitted ledger: catch it,
    // record KILL_FAILED, and press on. The always-emit invariant holds even
    // when a real IO seam rejects.
    try {
      const kill = await killProcess({ pid });
      if (kill.stopped) {
        processLedger = { pid, status: PROCESS_STATUS.STOPPED, forced: !!kill.forced, detail: kill.detail };
        record(`app stopped (pid ${pid})${kill.forced ? " [force-killed: SIGKILL fallback]" : ""}: ${kill.detail}`);
      } else if (kill.mayBeRunning) {
        // The kill was NOT ATTEMPTED (e.g. win32 process-group signalling is
        // unsupported) — this is a "couldn't stop", not a failed attempt, so it
        // is non-fatal (matches the null-PID may-be-running treatment): the
        // ledger reports the app may still be running and `ok` is left intact.
        processLedger = { pid, status: PROCESS_STATUS.MAY_BE_RUNNING, forced: !!kill.forced, detail: kill.detail };
        record(`app stop: ${kill.detail}`);
      } else {
        processLedger = { pid, status: PROCESS_STATUS.KILL_FAILED, forced: !!kill.forced, detail: kill.detail };
        fail(`app stop FAILED (pid ${pid}): ${kill.detail}`);
      }
    } catch (err) {
      processLedger = { pid, status: PROCESS_STATUS.KILL_FAILED, forced: false, detail: `kill seam threw: ${err?.message ?? err}` };
      fail(`app stop FAILED (pid ${pid}): kill seam threw: ${err?.message ?? err}`);
    }
  }

  // 2. Drop dev-DB rows — DESTRUCTIVE, confirmation-gated, dev DB only. Only ever
  //    drops an explicit manifest; never guesses untagged rows (see file header).
  const hasManifest = Array.isArray(rowManifest) && rowManifest.length > 0;
  let rowsLedger;
  if (!confirm) {
    if (hasManifest) {
      rowsLedger = { status: ROW_STATUS.SKIPPED_UNCONFIRMED, dropped: 0, candidates: rowManifest.length, detail: `${rowManifest.length} row(s) NOT dropped: teardown not confirmed` };
      record(`row drop skipped (not confirmed): ${rowManifest.length} manifest row(s) remain`);
    } else if (driveMayHaveCreatedRows(driveResult)) {
      rowsLedger = { status: ROW_STATUS.MAY_REMAIN_UNTAGGED, dropped: 0, candidates: 0, detail: "rows may remain (untagged): drive created rows but no session tag/manifest to target them, and teardown not confirmed" };
      record("row drop skipped: rows may remain (untagged)");
    } else {
      rowsLedger = { status: ROW_STATUS.NONE, dropped: 0, candidates: 0, detail: "no rows created (drive drove no mutating steps)" };
    }
  } else if (hasManifest) {
    try {
      const drop = await dropRows({ rows: rowManifest });
      if (drop.ok) {
        rowsLedger = { status: ROW_STATUS.DROPPED, dropped: drop.dropped ?? rowManifest.length, candidates: rowManifest.length, detail: drop.detail };
        record(`dev-DB rows dropped: ${drop.dropped ?? rowManifest.length} (${drop.detail})`);
      } else {
        rowsLedger = { status: ROW_STATUS.DROP_FAILED, dropped: drop.dropped ?? 0, candidates: rowManifest.length, detail: drop.detail };
        fail(`dev-DB row drop FAILED: ${drop.detail}`);
      }
    } catch (err) {
      rowsLedger = { status: ROW_STATUS.DROP_FAILED, dropped: 0, candidates: rowManifest.length, detail: `drop seam threw: ${err?.message ?? err}` };
      fail(`dev-DB row drop FAILED: drop seam threw: ${err?.message ?? err}`);
    }
  } else if (driveMayHaveCreatedRows(driveResult)) {
    // Confirmed, but nothing to target: honesty over a guess-drop.
    rowsLedger = { status: ROW_STATUS.MAY_REMAIN_UNTAGGED, dropped: 0, candidates: 0, detail: "rows may remain (untagged): drive created rows but no session tag/manifest to target them; refusing to guess which rows to drop" };
    record("row drop: rows may remain (untagged) — no manifest to target, not guessing");
  } else {
    rowsLedger = { status: ROW_STATUS.NONE, dropped: 0, candidates: 0, detail: "no rows created (drive drove no mutating steps)" };
  }

  // 3. Remove the worktree — DESTRUCTIVE, confirmation-gated. Delegated to the
  //    shared cleanup path, which refuses anything outside the loop namespace.
  let worktreeLedger;
  if (worktreePathMalformed) {
    worktreeLedger = { path: null, removed: false, status: WORKTREE_STATUS.REMOVE_FAILED, detail: `malformed worktree path in provision result (not a string): ${typeof rawWorktreePath}` };
    fail(`worktree removal FAILED: malformed worktree path in provision result (not a string): ${typeof rawWorktreePath}`);
  } else if (!worktreePath) {
    worktreeLedger = { path: null, removed: false, status: WORKTREE_STATUS.MISSING_PATH, detail: "no worktree path in provision result" };
    record("worktree removal skipped: no worktree path in provision result");
  } else if (!confirm) {
    worktreeLedger = { path: worktreePath, removed: false, status: WORKTREE_STATUS.SKIPPED_UNCONFIRMED, detail: "worktree retained: teardown not confirmed" };
    record(`worktree removal skipped (not confirmed): ${worktreePath} retained`);
  } else {
    try {
      const rm = await removeWorktree({ worktreePath });
      if (rm.removed) {
        worktreeLedger = { path: worktreePath, removed: true, status: WORKTREE_STATUS.REMOVED, detail: rm.detail };
        record(`worktree removed: ${worktreePath} (${rm.detail})`);
      } else {
        worktreeLedger = { path: worktreePath, removed: false, status: WORKTREE_STATUS.REMOVE_FAILED, detail: rm.detail };
        fail(`worktree removal FAILED: ${worktreePath} (${rm.detail})`);
      }
    } catch (err) {
      worktreeLedger = { path: worktreePath, removed: false, status: WORKTREE_STATUS.REMOVE_FAILED, detail: `removeWorktree seam threw: ${err?.message ?? err}` };
      fail(`worktree removal FAILED: ${worktreePath} (removeWorktree seam threw: ${err?.message ?? err})`);
    }
  }

  // The ledger is ALWAYS emitted (every case), enumerating every known side
  // effect. Migrations are recorded as applied-not-reverted by design.
  const ledger = {
    confirmed: confirm,
    migrations: {
      applied: migrations.applied ?? 0,
      reverted: false,
      detail: migrations.detail ?? null,
      note: "not reverted (dev DB; migration reversal is a separate explicit action)",
    },
    rows: rowsLedger,
    worktree: worktreeLedger,
    process: processLedger,
  };

  return { ok: errors.length === 0, confirmed: confirm, ledger, errors, logs };
}

export { ROW_STATUS, WORKTREE_STATUS, PROCESS_STATUS };
