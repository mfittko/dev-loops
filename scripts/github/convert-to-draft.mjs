#!/usr/bin/env node
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { convertPrToDraft } from "./_draft-transition.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage: convert-to-draft.mjs --repo <owner/name> --pr <number>
Sanctioned wrapper for the ready->draft transition. Converts a ready PR to
draft via the GraphQL convertPullRequestToDraft mutation. Idempotent: an
already-draft PR reports action "already_draft" and exits 0 without mutating
anything. Carries no policy flags.
Required:
  --repo <owner/name>   Repository slug (e.g. owner/repo)
  --pr <number>         Pull request number
Output (stdout, JSON):
  { "ok": true, "action": "converted"|"already_draft", "repo": "owner/repo", "pr": 17, "isDraft": true }
Error output (stderr, JSON):
  { "ok": false, "error": "...", "usage": "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success — PR is now (or already was) draft
  1  Argument error or gh failure
  2  Invalid --jq filter`.trim();
const parseError = buildParseError(USAGE);

export function parseConvertToDraftCliArgs(argv) {
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
  if (!options.repo || options.pr === undefined) throw parseError("convert-to-draft requires --repo and --pr");
  parseRepoSlug(options.repo);
  return options;
}

export async function convertToDraft(options, { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {}) {
  const result = await convertPrToDraft({ repo: options.repo, pr: options.pr }, { env, ghCommand, runChild });
  return {
    ok: true,
    action: result.alreadyDraft ? "already_draft" : "converted",
    repo: options.repo,
    pr: options.pr,
    isDraft: true,
  };
}

export async function main(argv = process.argv.slice(2), runtime = {}) {
  const options = parseConvertToDraftCliArgs(argv);
  if (options.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  const result = await convertToDraft(options, runtime);
  return emitResult(result, { jq: options.jq, silent: options.silent });
}

if (isDirectCliRun(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 1;
  });
}
