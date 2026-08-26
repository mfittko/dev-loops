/**
 * Shared `gh` CLI invoke-and-parse helpers (child 6 of the simplification
 * epic #1689). This module introduces the shared implementation only; the
 * ~19 call-site migrations are the follow-up children (projects: #1696;
 * github/loop/refine: #1697).
 *
 * `ghJson` reproduces the shape used by scripts/github/probe-ci-status.mjs
 * (`gh command failed:` on non-zero exit; `Invalid JSON from gh: ...` on
 * malformed stdout). `ghGraphql` reproduces scripts/projects/add-queue-item.mjs's
 * superset (`gh api graphql failed` / `GraphQL errors:` with GH_API_ERROR /
 * GRAPHQL_ERROR; `parseJsonText` → `Invalid JSON input`).
 *
 * Migration is NOT a uniform behavioral no-op across every current caller —
 * the callers do not all share one message shape:
 *   - probe-ci-status.mjs: already matches `ghJson` above (no-op).
 *   - upsert-checkpoint-verdict.mjs / post-gate-findings.mjs: today delegate
 *     JSON parsing to `parseJsonText`, so their malformed-stdout message is
 *     `Invalid JSON input`, NOT `Invalid JSON from gh: ...`.
 *   - fetch-ci-logs.mjs: today throws `<label> failed:`, NOT `gh command failed:`.
 * Migrating those callers onto `ghJson` will change their thrown-message text;
 * #1696/#1697 must reconcile each caller's pinned message (accept the shared
 * shape and update its test pins, or extend this helper) — it is not a blind
 * swap.
 */

import { runChild as defaultRunChild } from "../cli/primitives.mjs";
import { parseJsonText } from "./review-threads.mjs";

/**
 * Run a `gh` subcommand and parse its stdout as JSON. Fails loudly on a
 * non-zero exit (naming the command's stderr) and on malformed JSON stdout.
 *
 * @param {string[]} args - argv passed to `ghCommand`.
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.ghCommand] - defaults to `"gh"`.
 * @param {typeof defaultRunChild} [opts.runChild] - injectable child-exec seam.
 */
export async function ghJson(args, { env, ghCommand = "gh", runChild = defaultRunChild } = {}) {
  const result = await runChild(ghCommand, args, env);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
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
 *   in the response is returned instead of thrown.
 */
export async function ghGraphql(query, vars, env, runChild = defaultRunChild, { allowErrors = false } = {}) {
  const fieldArgs = [];
  for (const [key, value] of Object.entries(vars)) {
    fieldArgs.push("--field", `${key}=${value}`);
  }
  const result = await runChild(
    "gh",
    ["api", "graphql", "--field", `query=${query}`, ...fieldArgs],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
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
