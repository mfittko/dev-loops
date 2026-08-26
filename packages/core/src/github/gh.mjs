/**
 * Shared `gh` CLI invoke-and-parse helpers (child 6 of the simplification
 * epic #1689). Extracted byte-identically from the near-duplicate
 * `runGhJson`/`ghJson`/`ghGraphql` implementations scattered across
 * scripts/github and scripts/projects (see e.g.
 * scripts/github/upsert-checkpoint-verdict.mjs, scripts/github/post-gate-findings.mjs,
 * scripts/github/probe-ci-status.mjs, scripts/github/fetch-ci-logs.mjs, and
 * scripts/projects/add-queue-item.mjs) so a future caller migration is a
 * behavioral no-op. This module only introduces the shared implementation —
 * it does not migrate any caller.
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
 * @param {string} [opts.label] - accepted for signature parity with
 *   fetch-ci-logs.mjs's `ghJson`. ponytail: not folded into the thrown
 *   message text below — those two message shapes are pinned byte-exact
 *   across every extracted call site, so a per-call label cannot vary them.
 */
export async function ghJson(args, { env, ghCommand = "gh", runChild = defaultRunChild, label } = {}) {
  void label;
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
