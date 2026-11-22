/**
 * Shared `gh` CLI invoke-and-parse helpers (child 6 of the simplification
 * epic #1689). This module introduces the shared implementation only; the
 * ~19 call-site migrations are the follow-up children (projects: #1696;
 * github/loop/refine: #1697).
 *
 * `ghJson` is the composed SUPERSET the callers share (per #1695's AC): a
 * label-conditional non-zero-exit message — `gh command failed: <detail>` with
 * no label (probe-ci-status shape) or `<label> failed: <detail>` with one
 * (fetch-ci-logs shape) — always carrying `code: "GH_API_ERROR"`, plus the
 * inline `Invalid JSON from gh: <stdout|<empty>>` malformed-stdout shape
 * (probe-ci-status). The one exception to `GH_API_ERROR` is a second secondary
 * rate limit: after one 30 s backoff and one retry, both
 * helpers throw `code: "RATE_LIMITED"` with `resetAt: null` and their own message
 * prefix. An injected `runChild` runs once with no retry.
 * `ghGraphql` reproduces scripts/projects/add-queue-item.mjs's
 * superset (`gh api graphql failed` / `GraphQL errors:` with GH_API_ERROR /
 * GRAPHQL_ERROR; `parseJsonText` → `Invalid JSON input`).
 *
 * Because `ghJson` is a composed superset, NO current caller matches it exactly
 * — migrating each is a deliberate behavior harmonization, not a blind swap:
 *   - probe-ci-status.mjs: `gh command failed:` / `Invalid JSON from gh:` already
 *     match; it gains the `GH_API_ERROR` code on non-zero exit.
 *   - fetch-ci-logs.mjs: `<label> failed:` matches (pass its label); it gains the
 *     `GH_API_ERROR` code and its malformed-JSON message becomes
 *     `Invalid JSON from gh:` (was `parseJsonText` → `Invalid JSON input`).
 *   - upsert-checkpoint-verdict.mjs / post-gate-findings.mjs: gain the code and
 *     their malformed-JSON message becomes `Invalid JSON from gh:` (was
 *     `Invalid JSON input`).
 * The follow-up children (projects: #1696; github/loop/refine: #1697) migrate
 * each caller and update its pinned test messages accordingly.
 */

import { runChild as defaultRunChild } from "../cli/primitives.mjs";
import { parseJsonText } from "./review-threads.mjs";

export const SECONDARY_RATE_LIMIT_BACKOFF_MS = 30_000;

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The typed error for a second secondary rate limit; `prefix` is the caller's documented message prefix. */
export function rateLimitedError(prefix, detail, cause) {
  return Object.assign(new Error(`${prefix}: ${String(detail).trim()}`), { code: "RATE_LIMITED", resetAt: null, cause });
}

/** Rewrap a failed sync gh call, keeping the typed `code` and `resetAt` (RATE_LIMITED, GH_THROTTLE_UNAVAILABLE) and the original error as `cause`. */
export function ghCommandFailed(err) {
  return Object.assign(new Error(`gh command failed: ${err instanceof Error ? err.message : String(err)}`), { code: err?.code, resetAt: err?.resetAt, cause: err });
}

/**
 * Run one gh child. Pacing lives in the default runChild (each attempt takes a
 * slot there). A secondary rate limit backs off once and retries. A second one
 * returns the limited result with `rateLimited: true`, so the caller throws
 * RATE_LIMITED with its own message prefix.
 */
async function runWithBackoff(runChild, command, args, env, { sleep, timeoutMs }) {
  if (runChild === defaultRunChild) {
    // The default runChild owns the one retry; map its RATE_LIMITED to the caller's own prefix.
    try {
      return await runChild(command, args, env, undefined, { sleep, timeoutMs });
    } catch (error) {
      if (error?.code !== "RATE_LIMITED") throw error;
      return { code: 1, stdout: "", stderr: error.message.replace(/^gh command failed: /, ""), rateLimited: true };
    }
  }
  // An injected runner (a caller with its own rate-limit handling, or a test stub) runs once with no retry.
  return runChild(command, args, env);
}

// A thrown error or a resolved `{ code, stderr }` result that carries a secondary limit.
// An error with a `stderr` property is read by stderr only: its message carries the whole gh argv (ADR 0305).
function isSecondaryLimited(outcome) {
  if (outcome instanceof Error) return isSecondaryRateLimitError(outcome.stderr === undefined ? outcome : String(outcome.stderr));
  return outcome?.code !== 0 && isSecondaryRateLimitError(String(outcome?.stderr ?? ""));
}

/**
 * Backoff for a direct async gh site that captures stderr. `attempt` takes a
 * slot and runs gh once, either throwing an error that carries the gh stderr or
 * resolving `{ code, stderr }`. A secondary rate limit backs off once and
 * retries, and a second one throws RATE_LIMITED. Streaming sites that inherit
 * stderr cannot see the limit and stay paced only.
 */
export async function withSecondaryLimitBackoff(attempt, { sleep = realSleep } = {}) {
  const settle = async () => { try { return { value: await attempt() }; } catch (error) { return { error }; } };
  const unwrap = ({ value, error }) => { if (error) throw error; return value; };
  let outcome = await settle();
  if (!isSecondaryLimited(outcome.error ?? outcome.value)) return unwrap(outcome);
  await sleep(SECONDARY_RATE_LIMIT_BACKOFF_MS);
  outcome = await settle();
  if (isSecondaryLimited(outcome.error ?? outcome.value)) {
    const limited = outcome.error ?? outcome.value;
    throw rateLimitedError("gh command failed", limited.stderr || limited.message || "secondary rate limit", outcome.error);
  }
  return unwrap(outcome);
}

/**
 * Run a `gh` subcommand and parse its stdout as JSON. Fails loudly on a
 * non-zero exit (naming the command's stderr) and on malformed JSON stdout.
 *
 * @param {string[]} args - argv passed to `ghCommand`.
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.ghCommand] - defaults to `"gh"`.
 * @param {typeof defaultRunChild} [opts.runChild] - injectable child-exec seam.
 * @param {string} [opts.label] - controls the non-zero-exit message: when set,
 *   the thrown error reads `<label> failed: <detail>` (the fetch-ci-logs shape);
 *   when omitted it reads `gh command failed: <detail>` (the probe-ci-status
 *   shape). Either way the non-zero-exit error carries `code: "GH_API_ERROR"`,
 *   except a second secondary rate limit, which carries `code: "RATE_LIMITED"`
 *   with the same prefix.
 * @param {(ms: number) => Promise<void>} [opts.sleep] - injectable backoff sleep.
 * @param {number} [opts.timeoutMs] - the default runner kills the child at this bound and ghJson throws `code: "GH_TIMEOUT"`; an injected runner ignores it.
 */
export async function ghJson(args, { env, ghCommand = "gh", runChild = defaultRunChild, label, sleep, timeoutMs } = {}) {
  const result = await runWithBackoff(runChild, ghCommand, args, env, { sleep, timeoutMs });
  // A child killed at the bound exits with a null code.
  if (result.code === null && timeoutMs !== undefined) throw Object.assign(new Error(`${label ? `${label} failed` : "gh command failed"}: timed out after ${timeoutMs}ms`), { code: "GH_TIMEOUT" });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    const prefix = label ? `${label} failed` : "gh command failed";
    if (result.rateLimited) throw rateLimitedError(prefix, detail);
    throw Object.assign(new Error(`${prefix}: ${detail}`), { code: "GH_API_ERROR" });
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Invalid JSON from gh: ${result.stdout.trim() || "<empty>"}`);
  }
}

/**
 * Run a `gh api graphql` query and parse its response.
 *
 * @param {string} query - the GraphQL document.
 * @param {Record<string, string>} vars - `--field key=value` variables.
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof defaultRunChild} [runChild] - injectable child-exec seam.
 * @param {object} [opts]
 * @param {boolean} [opts.allowErrors] - when true, a GraphQL `errors` array
 *   in the response is returned instead of thrown. This includes a non-zero
 *   `gh` exit whose stdout is JSON with an `errors` array.
 * @param {(ms: number) => Promise<void>} [opts.sleep] - injectable backoff sleep.
 *   A second secondary limit throws `RATE_LIMITED` with the `gh api graphql failed:` prefix.
 */
export async function ghGraphql(query, vars, env, runChild = defaultRunChild, { allowErrors = false, sleep } = {}) {
  const fieldArgs = [];
  for (const [key, value] of Object.entries(vars)) {
    fieldArgs.push("--field", `${key}=${value}`);
  }
  const result = await runWithBackoff(
    runChild,
    "gh",
    ["api", "graphql", "--field", `query=${query}`, ...fieldArgs],
    env,
    { sleep },
  );
  if (result.code !== 0) {
    // `gh api graphql` exits non-zero when the response carries GraphQL
    // `errors` (e.g. NOT_FOUND) but still prints the JSON on stdout. With
    // allowErrors the caller wants that errors array, so return it.
    if (allowErrors) {
      let errorPayload = null;
      try {
        errorPayload = JSON.parse(result.stdout);
      } catch {
        // not JSON: fall through to GH_API_ERROR
      }
      if (Array.isArray(errorPayload?.errors)) return errorPayload;
    }
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    if (result.rateLimited) throw rateLimitedError("gh api graphql failed", detail);
    throw Object.assign(new Error(`gh api graphql failed: ${detail}`), { code: "GH_API_ERROR" });
  }
  const payload = parseJsonText(result.stdout);
  if (!allowErrors && payload.errors && payload.errors.length > 0) {
    throw Object.assign(
      new Error(`GraphQL errors: ${payload.errors.map((e) => e.message).join("; ")}`),
      { code: "GRAPHQL_ERROR" },
    );
  }
  return payload;
}

const GET_USER_ID = [
  "query($login:String!) {",
  "  user(login:$login) { id }",
  "}",
].join("\n");

const GET_ORG_ID = [
  "query($login:String!) {",
  "  organization(login:$login) { id }",
  "}",
].join("\n");

/**
 * Resolve a GitHub owner login to its node id and kind. Probes the user
 * namespace first; a not-a-user probe failure (org logins make `gh api graphql`
 * exit non-zero) falls through to the org namespace instead of throwing (#1949).
 * A login that is neither a user nor an org fails closed with NO_USER_ID.
 *
 * The issue's "Proposed fix" wrapped only the user probe, but AC #3 requires
 * NO_USER_ID for a genuinely non-existent owner; in production the org probe
 * on a missing org also throws (non-zero exit), so both probes must be caught
 * for the AC to hold. `cause` preserves the underlying org error for
 * diagnostics. This does not change `ghGraphql`'s throw-on-non-zero-exit
 * contract.
 */
export async function resolveOwner(login, env, runChild) {
  try {
    const userPayload = await ghGraphql(GET_USER_ID, { login }, env, runChild);
    if (userPayload?.data?.user?.id) {
      return { id: userPayload.data.user.id, kind: "user" };
    }
  } catch {
    // not a user login → fall through to the org probe
  }
  let orgError;
  try {
    const orgPayload = await ghGraphql(GET_ORG_ID, { login }, env, runChild);
    if (orgPayload?.data?.organization?.id) {
      return { id: orgPayload.data.organization.id, kind: "org" };
    }
  } catch (err) {
    orgError = err;
  }
  throw Object.assign(
    new Error(`Could not resolve owner ID for "${login}"`),
    { code: "NO_USER_ID", cause: orgError },
  );
}

// Anchored to gh's own phrasings ("API rate limit exceeded", "rate limit already
// exceeded", "You have exceeded a secondary rate limit"). A bare `rate limit`
// substring also matches an echoed PR title or proxy body, and classifying those
// as rate limits shows the operator a retry time that will never come true.
export function isRateLimitError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /rate limit[^\n]{0,20}\bexceeded\b|\bexceeded\b[^\n]{0,20}rate limit/i.test(message);
}

// A secondary (abuse) rate limit message from gh, matched on raw stderr or an Error.
export function isSecondaryRateLimitError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /secondary rate limit/i.test(message);
}

// Sanity bound: a GraphQL reset further ahead than this is a bogus reading.
const GRAPHQL_RATE_LIMIT_MAX_RESET_AHEAD_MS = 24 * 60 * 60 * 1000;

/**
 * Run `operation`; on a rate-limit error, read the GraphQL reset from
 * `gh api rate_limit` (a REST read that spends no GraphQL points), sleep until
 * that reset, and retry once. Fails closed with `code: "RATE_LIMITED"` and
 * `resetAt` (ISO 8601, or null when unknown) when GraphQL budget remains
 * (`remaining` is not 0), when the reset is unknown, in the past, more than 24h
 * ahead, or beyond `maxWaitMs`, or when the retry is rate limited again (then
 * `resetAt` is null). Every other error is rethrown unchanged.
 *
 * @param {() => Promise<any>} operation
 * @param {object} opts
 * @param {number | (() => number)} opts.maxWaitMs - evaluated at failure time.
 * @param {(ms: number) => Promise<void>} opts.sleep
 */
export async function withGraphqlRateLimitWait(
  operation,
  { maxWaitMs, sleep, now = Date.now, env, ghCommand = "gh", runChild = defaultRunChild },
) {
  try {
    return await operation();
  } catch (error) {
    if (!isRateLimitError(error)) throw error;
  }
  let graphql = null;
  try {
    graphql = (await ghJson(["api", "rate_limit"], { env, ghCommand, runChild }))?.resources?.graphql ?? null;
  } catch {
    // unreadable reset: fail closed below with resetAt null
  }
  // A rate-limit error while GraphQL budget remains came from a REST core,
  // search, or secondary limit; waiting for the GraphQL reset cannot help.
  const reset = graphql?.remaining === 0 ? graphql.reset : null;
  const waitMs = Number.isFinite(reset) ? reset * 1000 - now() : Number.NaN;
  const capMs = typeof maxWaitMs === "function" ? maxWaitMs() : maxWaitMs;
  const usable = waitMs > 0 && waitMs <= GRAPHQL_RATE_LIMIT_MAX_RESET_AHEAD_MS && waitMs <= capMs;
  // An absurd finite reset is an invalid Date; report it as unknown instead of letting toISOString throw.
  const resetDate = new Date(Number.isFinite(reset) ? reset * 1000 : Number.NaN);
  const resetAt = Number.isNaN(resetDate.getTime()) ? null : resetDate.toISOString();
  const graphqlBudgetLeft = Number.isFinite(graphql?.remaining) && graphql.remaining > 0;
  const rateLimited = (reportedResetAt) => Object.assign(
    new Error(graphqlBudgetLeft
      ? "GitHub rate limit hit on a non-GraphQL budget; no reset wait"
      : `GitHub GraphQL rate limit exhausted; retry after ${reportedResetAt ?? "unknown reset"}`),
    { code: "RATE_LIMITED", resetAt: reportedResetAt },
  );
  if (!usable) throw rateLimited(resetAt);
  await sleep(waitMs);
  try {
    return await operation();
  } catch (error) {
    // The pre-sleep reset has already passed; report it as unknown rather than stale.
    throw isRateLimitError(error) ? rateLimited(null) : error;
  }
}

/** Map a RATE_LIMITED error onto the tools' `ok: false` result shape. */
export function rateLimitedResult(error) {
  return { ok: false, code: "RATE_LIMITED", error: error.message, resetAt: error.resetAt ?? null };
}
