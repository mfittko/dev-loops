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
 * (probe-ci-status). `ghGraphql` reproduces scripts/projects/add-queue-item.mjs's
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
 *   shape). Either way the non-zero-exit error carries `code: "GH_API_ERROR"`.
 */
export async function ghJson(args, { env, ghCommand = "gh", runChild = defaultRunChild, label } = {}) {
  const result = await runChild(ghCommand, args, env);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    const prefix = label ? `${label} failed` : "gh command failed";
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
