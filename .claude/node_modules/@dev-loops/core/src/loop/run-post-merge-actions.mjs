/**
 * Post-merge actions runner (config family: `postMerge.actions`, #1457).
 *
 * Runs a repo's declared `postMerge.actions` sequentially, in declared order,
 * after the dev-loop's merge succeeds — sync a checkout, restart a local
 * service, run a smoke check. Mirrors the `uiReview.run` recipe's shape and
 * execution precedent (`packages/core/src/loop/ui-review-provision.mjs`).
 *
 * SECURITY: `action.run` / `action.verify` are executed VERBATIM as the
 * operator declared them in the repo's own committed `.devloops` (same trust
 * level as `uiReview.run.command`) — this module never builds a command string
 * by concatenating runtime data (changed-file paths, verify output) into it.
 * `onlyIfChanged` scoping matches changed-file paths as DATA (plain substring
 * compare), never by shelling them out. Every `run`/`verify` invocation is
 * bounded by its own timeout; `verify` polling is bounded by `verifyTimeoutMs`.
 *
 * Pure orchestration: the shell-out (`exec`) and clock (`now`/`delay`) are
 * injected so this module is fully deterministic under test. The CLI wires the
 * real seams (scripts/loop/run-post-merge-actions.mjs).
 */

/**
 * True when at least one changed path contains at least one `onlyIfChanged`
 * pattern (plain substring match — never a shell-out, never a regex).
 */
function matchesOnlyIfChanged(patterns, changedPaths) {
  return patterns.some((pattern) => changedPaths.some((changedPath) => changedPath.includes(pattern)));
}

/**
 * Decide whether `action` runs. Returns a skip-reason string, or `null` to run
 * it. `changedPaths === null` means the changed-file list could not be
 * resolved (no PR number, `gh pr diff` failure): AC5 requires an
 * `onlyIfChanged` action to still run in that case (never silently skipped),
 * so the bypass is a run, not a skip.
 */
function decideSkip(action, changedPaths) {
  if (!Array.isArray(action.onlyIfChanged) || action.onlyIfChanged.length === 0) return null;
  if (changedPaths === null) return null; // AC5: scoping unresolved — run unscoped
  if (matchesOnlyIfChanged(action.onlyIfChanged, changedPaths)) return null;
  return `no changed file matched onlyIfChanged (${action.onlyIfChanged.join(", ")})`;
}

/** Run `command` bounded by `timeoutMs` via the injected `exec` seam. */
async function execBounded(exec, command, cwd, timeoutMs) {
  let result;
  try {
    result = await exec(command, { cwd, timeoutMs });
  } catch (err) {
    return { ok: false, detail: (err && err.message) || String(err) };
  }
  if (result?.killed) return { ok: false, detail: `timed out after ${timeoutMs}ms` };
  if (result?.code !== 0) {
    const stderr = typeof result?.stderr === "string" ? result.stderr.trim() : "";
    return { ok: false, detail: `exit code ${result?.code}${stderr ? `: ${stderr}` : ""}` };
  }
  return { ok: true, detail: null };
}

/**
 * Poll `verifyCommand` (bounded per-attempt by the remaining budget) until it
 * exits 0 or `verifyTimeoutMs` elapses. Mirrors the readiness poll in
 * `ui-review-provision.mjs`'s `provisionAndBoot` (never a fixed sleep).
 */
async function pollVerify(exec, verifyCommand, cwd, verifyTimeoutMs, verifyIntervalMs, { delay, now }) {
  const deadline = now() + verifyTimeoutMs;
  let lastDetail = "verify never ran";
  while (now() <= deadline) {
    const attemptBudget = Math.max(1, deadline - now());
    let result;
    try {
      result = await exec(verifyCommand, { cwd, timeoutMs: attemptBudget });
    } catch (err) {
      result = { code: 1, killed: false, stdout: "", stderr: (err && err.message) || String(err) };
    }
    if (!result?.killed && result?.code === 0) return { ok: true, detail: null };
    const verifyStderr = typeof result?.stderr === "string" ? result.stderr.trim() : "";
    lastDetail = result?.killed
      ? "verify command timed out"
      : `exit code ${result?.code}${verifyStderr ? `: ${verifyStderr}` : ""}`;
    if (now() + verifyIntervalMs > deadline) break; // would overshoot the deadline
    await delay(verifyIntervalMs);
  }
  return { ok: false, detail: `verify exhausted after ${verifyTimeoutMs}ms (${lastDetail})` };
}

/**
 * Run every declared action sequentially, in order, with cwd set to `cwd`
 * (the resolved main checkout).
 *
 * @param {object} input
 * @param {{name:string,run:string,onlyIfChanged:string[]|null,verify:string|null,
 *   timeoutMs:number,verifyTimeoutMs:number,verifyIntervalMs:number}[]} input.actions
 * @param {string[]|null} input.changedPaths - Changed file paths of the merged
 *   PR, or `null` when unresolved (AC5 bypass).
 * @param {string} [input.changedPathsUnavailableReason] - Why `changedPaths` is
 *   `null` (e.g. "no PR number", "gh pr diff failed: ..."), surfaced in the
 *   bypass warning so the AC5 "states why scoping was bypassed" reads clearly.
 * @param {string} input.cwd - Absolute path to the main checkout.
 * @param {object} seams
 * @param {(command:string, opts:{cwd:string,timeoutMs:number})=>Promise<{code:number|null,killed:boolean,stdout:string,stderr:string}>} seams.exec
 * @param {(ms:number)=>Promise<void>} [seams.delay]
 * @param {()=>number} [seams.now]
 * @param {(msg:string)=>void} [seams.log]
 * @returns {Promise<{ok:boolean, results:{name:string,status:"ok"|"skipped"|"failed",detail:string|null}[]}>}
 */
export async function runPostMergeActions(
  { actions = [], changedPaths = null, changedPathsUnavailableReason = "unknown reason", cwd },
  { exec, delay = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), log = () => {} } = {},
) {
  if (changedPaths === null && actions.some((a) => Array.isArray(a.onlyIfChanged) && a.onlyIfChanged.length > 0)) {
    log(`WARNING: changed-file list unavailable (${changedPathsUnavailableReason}) — onlyIfChanged scoping bypassed (affected actions run unscoped)`);
  }

  const results = [];
  for (const action of actions) {
    const skipReason = decideSkip(action, changedPaths);
    if (skipReason) {
      log(`skip ${action.name}: ${skipReason}`);
      results.push({ name: action.name, status: "skipped", detail: skipReason });
      continue;
    }

    log(`run ${action.name}: ${action.run}`);
    const runResult = await execBounded(exec, action.run, cwd, action.timeoutMs);
    if (!runResult.ok) {
      const detail = `run failed: ${runResult.detail}`;
      log(`FAILED ${action.name}: ${detail}`);
      results.push({ name: action.name, status: "failed", detail });
      continue;
    }

    if (action.verify) {
      log(`verify ${action.name}: ${action.verify}`);
      const verifyResult = await pollVerify(exec, action.verify, cwd, action.verifyTimeoutMs, action.verifyIntervalMs, { delay, now });
      if (!verifyResult.ok) {
        log(`FAILED ${action.name}: ${verifyResult.detail}`);
        results.push({ name: action.name, status: "failed", detail: verifyResult.detail });
        continue;
      }
    }

    log(`ok ${action.name}`);
    results.push({ name: action.name, status: "ok", detail: null });
  }

  return { ok: results.every((r) => r.status !== "failed"), results };
}
