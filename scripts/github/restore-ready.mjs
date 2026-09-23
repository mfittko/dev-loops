#!/usr/bin/env node
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { readyForReview } from "./ready-for-review.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage: restore-ready.mjs --repo <owner/name> --pr <number>
Restores a transient draft PR to ready when CI is still blocking (the
transient-draft restore direction: convert-to-draft.mjs's counterpart).
Reuses every ready-for-review.mjs guard — draft state, title markers, clean
current-head draft_gate evidence, zero unresolved gate-authored review
threads, size budget, ADR tripwire, comment discipline, and the PR-body spec
— EXCEPT the CI precondition, which this script disables through an internal
runtime seam (no CLI flag exists on this script or on ready-for-review.mjs to
skip CI). The CI precondition is redundant here: the clean current-head
draft_gate verdict already carried the gates.draft.requireCi precondition
when it was posted.
This script accepts NO size-budget waiver flags: a PR over the size budget
restores via \`dev-loops pr ready-for-review --waive-size-budget --reason
<text> [--approved-by <human>]\` once CI is green, not through restore-ready.
Required:
  --repo <owner/name>   Repository slug (e.g. owner/repo)
  --pr <number>         Pull request number
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success — PR is marked ready again
  1  Argument error, gh failure, or a ready-for-review.mjs guard refused
  2  Invalid --jq filter`.trim();
const parseError = buildParseError(USAGE);

export function parseRestoreReadyCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: { help: { type: "boolean", short: "h" }, repo: { type: "string" }, pr: { type: "string" }, ...JQ_OUTPUT_PARSE_OPTIONS },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = { help: false, repo: undefined, pr: undefined };
  for (const token of tokens) {
    if (token.kind === "positional") throw parseError(`Unknown argument: ${token.value}`);
    if (token.kind !== "option") continue;
    if (token.name === "help") { options.help = true; return options; }
    if (token.name === "repo") { options.repo = requireTokenValue(token, parseError).trim(); continue; }
    if (token.name === "pr") { options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError); continue; }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (!options.repo || options.pr === undefined) throw parseError("restore-ready requires --repo and --pr");
  parseRepoSlug(options.repo);
  return options;
}

export async function restoreReady(options, runtime = {}) {
  return readyForReview(options, { ...runtime, skipCiPrecondition: true });
}

export async function main(argv = process.argv.slice(2), runtime = {}) {
  const options = parseRestoreReadyCliArgs(argv);
  if (options.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  const result = await restoreReady(options, runtime);
  return emitResult(result, { jq: options.jq, silent: options.silent });
}

if (isDirectCliRun(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 1;
  });
}
