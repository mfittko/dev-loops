#!/usr/bin/env node
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { loadDevLoopConfig } from "@dev-loops/core/config";
import { resolveHandoffCandidates } from "./resolve-handoff-candidates.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage: offer-human-handoff.mjs --repo <owner/name> --pr <number> [--assign <login>...] [--request-review <login>...] [--changed-files <csv>] [--pr-author <login>]
Human-handoff offer at the pre-approval / merge-handoff boundary (#920, Request B
of #910). OFFER-only: without --assign/--request-review it resolves and prints
the candidate list (the "offer"); the operator confirms who takes it. With
--assign / --request-review it performs the confirmed action via \`gh pr edit\`.

This pairs with autonomy.humanMergeOnly: when human-merge is enforced, the offer
names who should take the merge. No-op when approval is disabled
(default) — prints an empty offer.

Required:
  --repo <owner/name>
  --pr <number>
Optional:
  --assign <login>          Add a confirmed assignee (repeatable). Performs
                            \`gh pr edit --add-assignee\`.
  --request-review <login>  Request review from a confirmed reviewer (repeatable).
                            Performs \`gh pr edit --add-reviewer\`.
  --changed-files <csv>     Forwarded to the candidate resolver.
  --pr-author <login>       Forwarded to the candidate resolver.
Output (stdout, JSON):
  Offer mode:  { "ok": true, "mode": "offer", "enabled", "candidates": [...], ... }
  Apply mode:  { "ok": true, "mode": "apply", "assigned": [...], "requestedReview": [...] }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success (including disabled no-op offer)
  1  Argument error or gh failure
  2  Invalid --jq filter`.trim();

const parseError = buildParseError(USAGE);

// A login flag value with the leading `@` stripped and trimmed. Reject an empty
// result (e.g. `--assign @`) so a blank login can never reach `gh pr edit
// --add-assignee ""`.
function loginValue(token) {
  const login = requireTokenValue(token, parseError).trim().replace(/^@/, "").trim();
  if (login === "") throw parseError(`${token.rawName} requires a non-empty login`);
  return login;
}

export function parseOfferCliArgs(argv) {
  const options = {
    help: false, repo: undefined, pr: undefined,
    assign: [], requestReview: [], changedFiles: undefined, prAuthor: undefined,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      assign: { type: "string", multiple: true },
      "request-review": { type: "string", multiple: true },
      "changed-files": { type: "string" },
      "pr-author": { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "repo") {
      options.repo = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "pr") {
      options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError);
      continue;
    }
    if (token.name === "assign") {
      options.assign.push(loginValue(token));
      continue;
    }
    if (token.name === "request-review") {
      options.requestReview.push(loginValue(token));
      continue;
    }
    if (token.name === "changed-files") {
      options.changedFiles = requireTokenValue(token, parseError)
        .split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      continue;
    }
    if (token.name === "pr-author") {
      options.prAuthor = requireTokenValue(token, parseError).trim().replace(/^@/, "");
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined || options.pr === undefined) {
    throw parseError("Offering human handoff requires both --repo <owner/name> and --pr <number>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}

/**
 * Perform the confirmed assign / request-review actions via `gh pr edit`.
 * OFFER-only contract: this is reached only when the operator passed
 * --assign / --request-review (the confirmation). It never auto-assigns.
 * @returns {Promise<{ ok: boolean, mode: "apply", assigned: string[], requestedReview: string[] }>}
 */
export async function applyHandoff({ repo, pr, assign, requestReview }, { run = (cmd, args) => runChild(cmd, args), ghCommand = "gh" } = {}) {
  const ghArgs = ["pr", "edit", String(pr), "--repo", repo];
  for (const login of assign) ghArgs.push("--add-assignee", login);
  for (const login of requestReview) ghArgs.push("--add-reviewer", login);
  const result = await run(ghCommand, ghArgs);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `gh pr edit exited ${result.code}`);
  }
  return { ok: true, mode: "apply", assigned: assign, requestedReview: requestReview };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  let options;
  try {
    options = parseOfferCliArgs(argv);
  } catch (error) {
    process.stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const run = deps.run ?? ((cmd, args) => runChild(cmd, args));
  const ghCommand = deps.ghCommand ?? "gh";

  // Apply mode: operator confirmed an assignee/reviewer.
  if (options.assign.length > 0 || options.requestReview.length > 0) {
    try {
      const applied = await applyHandoff(
        { repo: options.repo, pr: options.pr, assign: options.assign, requestReview: options.requestReview },
        { run, ghCommand },
      );
      return emitResult(applied, { jq: options.jq, silent: options.silent });
    } catch (error) {
      process.stderr.write(`${formatCliError(error)}\n`);
      return 1;
    }
  }

  // Offer mode: resolve + print candidates, assign nobody.
  const repoRoot = deps.repoRoot ?? process.cwd();
  const config = deps.config !== undefined ? deps.config : (await loadDevLoopConfig({ repoRoot })).config;
  const offer = await resolveHandoffCandidates(
    { repo: options.repo, pr: options.pr, changedFiles: options.changedFiles, prAuthor: options.prAuthor ?? null },
    { ...deps, config, repoRoot, run, ghCommand },
  );
  return emitResult({ ...offer, mode: "offer" }, { jq: options.jq, silent: options.silent });
}

if (isDirectCliRun(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
