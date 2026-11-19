import { runChild as defaultRunChild } from "../_cli-primitives.mjs";
import {
  summarizeHeadScopedCheckRunsSignal,
  normalizeHeadScopedCommitStatus,
  partitionEntriesByCheckName,
  LOOP_DERIVED_CI_CHECK_NAME,
  LOOP_DERIVED_CI_CHECK_NAMES,
} from "@dev-loops/core/loop/copilot-ci-status";

// Failing commit-status contexts (state "failure"/"error"), e.g. CircleCI which
// reports through the status API rather than as check-runs.
function extractFailedStatusContexts(statuses) {
  if (!Array.isArray(statuses)) return [];
  return statuses
    .filter((s) => {
      const state = typeof s?.state === "string" ? s.state.toLowerCase() : "";
      return state === "failure" || state === "error";
    })
    .map((s) => ({
      name: typeof s?.context === "string" && s.context.length > 0 ? s.context : "unknown",
      conclusion: typeof s?.state === "string" ? s.state.toLowerCase() : "",
    }));
}

// `gh api --paginate --slurp` prints an array of page payloads; a single
// payload object is also accepted. Returns the merged `key` array, or null
// when any page lacks it.
function mergePagedArray(payload, key) {
  const pages = Array.isArray(payload) ? payload : [payload];
  if (pages.length === 0 || !pages.every((p) => Array.isArray(p?.[key]))) return null;
  return pages.flatMap((p) => p[key]);
}

function invalidCheckRuns() {
  return {
    ok: false,
    rawCount: null,
    nonLoopDerivedCount: null,
    loopDerivedFailureDetails: [],
    visibleSignal: null,
    fullSignal: null,
    excludedSignal: null,
  };
}

function invalidStatuses() {
  return {
    ok: false,
    rawCount: null,
    nonLoopDerivedCount: null,
    commitStatus: null,
    excludedFailureDetails: [],
    statusFailures: [],
  };
}

// Parse one `commits/{sha}/check-runs` payload into raw, lossless signals.
// Loop-derived (gate-evidence) entries are partitioned out so the caller's
// wait never blocks on the loop's own derived signal; PR-visible filtering,
// full-set, and hidden ("excluded") signals are computed so each caller can
// retain its own projection. Non-zero exit, unparseable JSON, or a missing
// `check_runs` array all read as `ok: false` (never fabricated empty).
function parseHeadCheckRuns(result, prVisibleCheckNames) {
  if (result.code !== 0) return invalidCheckRuns();
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return invalidCheckRuns();
  }
  const checkRuns = mergePagedArray(payload, "check_runs");
  if (!checkRuns) return invalidCheckRuns();

  const { matched: loopDerivedRuns, rest: nonLoopDerivedRuns } =
    partitionEntriesByCheckName(checkRuns, LOOP_DERIVED_CI_CHECK_NAMES);
  const loopDerivedFailureDetails =
    summarizeHeadScopedCheckRunsSignal({ check_runs: loopDerivedRuns }).status === "failure"
      ? [LOOP_DERIVED_CI_CHECK_NAME]
      : [];
  const visibleSet = prVisibleCheckNames?.length > 0 ? new Set(prVisibleCheckNames) : null;
  const visibleRuns = visibleSet
    ? nonLoopDerivedRuns.filter((run) => !run.name || visibleSet.has(run.name))
    : nonLoopDerivedRuns;
  const excludedRuns = visibleSet
    ? nonLoopDerivedRuns.filter((run) => run.name && !visibleSet.has(run.name))
    : [];
  return {
    ok: true,
    rawCount: checkRuns.length,
    nonLoopDerivedCount: nonLoopDerivedRuns.length,
    loopDerivedFailureDetails,
    visibleSignal: summarizeHeadScopedCheckRunsSignal({ check_runs: visibleRuns }),
    fullSignal: summarizeHeadScopedCheckRunsSignal({ check_runs: nonLoopDerivedRuns }),
    excludedSignal: summarizeHeadScopedCheckRunsSignal({ check_runs: excludedRuns }),
  };
}

// Parse one `commits/{sha}/status` payload into raw, lossless signals. The same
// gate-evidence loop-derived exclusion is mirrored for the commit-status API.
function parseHeadCommitStatuses(result) {
  if (result.code !== 0) return invalidStatuses();
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return invalidStatuses();
  }
  const allStatuses = mergePagedArray(payload, "statuses");
  if (!allStatuses) return invalidStatuses();

  const { matched: loopDerivedStatuses, rest: nonLoopDerivedStatuses } =
    partitionEntriesByCheckName(allStatuses, LOOP_DERIVED_CI_CHECK_NAME);
  const excludedFailureDetails =
    normalizeHeadScopedCommitStatus({ statuses: loopDerivedStatuses }) === "failure"
      ? [LOOP_DERIVED_CI_CHECK_NAME]
      : [];
  return {
    ok: true,
    rawCount: allStatuses.length,
    nonLoopDerivedCount: nonLoopDerivedStatuses.length,
    commitStatus: normalizeHeadScopedCommitStatus({ statuses: nonLoopDerivedStatuses }),
    excludedFailureDetails,
    statusFailures: extractFailedStatusContexts(nonLoopDerivedStatuses),
  };
}

/**
 * Read + parse the combined check-runs + commit-status state for one head SHA
 * in a single matching observation (one parallel fetch pair). Provider-agnostic:
 * covers GitHub Actions, CircleCI, and any external commit-status / check-run.
 *
 * Returns only lossless raw signals — validity, counts (raw and
 * loop-derived-excluded), visible/full/hidden signals, commit status, and
 * exclusions. It does NOT decide pending/success/failure; each caller projects
 * its own terminal classification (fetch-error policy, no-check grace,
 * queued-stall, one-surviving-provider tolerance) from these.
 *
 * @returns {{
 *   checkRuns: { ok: boolean, rawCount: number|null, nonLoopDerivedCount: number|null,
 *     loopDerivedFailureDetails: Array<string>, visibleSignal: object|null,
 *     fullSignal: object|null, excludedSignal: object|null },
 *   statuses: { ok: boolean, rawCount: number|null, nonLoopDerivedCount: number|null,
 *     commitStatus: ("success"|"failure"|"pending"|"none")|null,
 *     excludedFailureDetails: Array<string>, statusFailures: Array<{ name: string, conclusion: string }> }
 * }}
 */
export async function observeHeadCiSignals(
  { repo, headSha, prVisibleCheckNames },
  { env, ghCommand, runChild = defaultRunChild },
) {
  const [checkRunsResult, statusesResult] = await Promise.all([
    runChild(ghCommand, ["api", "--paginate", "--slurp", `repos/${repo}/commits/${headSha}/check-runs?per_page=100`], env),
    runChild(ghCommand, ["api", "--paginate", "--slurp", `repos/${repo}/commits/${headSha}/status?per_page=100`], env),
  ]);
  return {
    checkRuns: parseHeadCheckRuns(checkRunsResult, prVisibleCheckNames),
    statuses: parseHeadCommitStatuses(statusesResult),
  };
}
