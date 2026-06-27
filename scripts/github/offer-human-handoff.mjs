#!/usr/bin/env node
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePrNumber, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { loadDevLoopConfig } from "@dev-loops/core/config";
import { resolveHandoffCandidates } from "./resolve-handoff-candidates.mjs";

const USAGE = `Usage: offer-human-handoff.mjs --repo <owner/name> --pr <number> [--assign <login>...] [--request-review <login>...] [--changed-files <csv>] [--pr-author <login>]
Human-handoff offer at the pre-approval / merge-handoff boundary (#920, Request B
of #910). OFFER-only: without --assign/--request-review it resolves and prints
the candidate list (the "offer"); the operator confirms who takes it. With
--assign / --request-review it performs the confirmed action via \`gh pr edit\`.

This pairs with autonomy.humanMergeOnly: when human-merge is enforced, the offer
names who should take the merge. No-op when approval.humanHandoff is disabled
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
Exit codes:
  0  Success (including disabled no-op offer)
  1  Argument error or gh failure`.trim();

const parseError = buildParseError(USAGE);

function nextValue(args, i, flag) {
  const value = args[i];
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
    throw parseError(`Missing value for ${flag}`);
  }
  return value;
}

export function parseOfferCliArgs(argv) {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const options = {
    help: false, repo: undefined, pr: undefined,
    assign: [], requestReview: [], changedFiles: undefined, prAuthor: undefined,
  };
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--repo") { options.repo = nextValue(args, ++i, "--repo"); continue; }
    if (token === "--pr") { options.pr = parsePrNumber(nextValue(args, ++i, "--pr"), parseError); continue; }
    if (token === "--assign") { options.assign.push(nextValue(args, ++i, "--assign").trim().replace(/^@/, "")); continue; }
    if (token === "--request-review") { options.requestReview.push(nextValue(args, ++i, "--request-review").trim().replace(/^@/, "")); continue; }
    if (token === "--changed-files") {
      options.changedFiles = nextValue(args, ++i, "--changed-files")
        .split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      continue;
    }
    if (token === "--pr-author") { options.prAuthor = nextValue(args, ++i, "--pr-author").trim().replace(/^@/, ""); continue; }
    throw parseError(`Unknown argument: ${token}`);
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
      process.stdout.write(`${JSON.stringify(applied)}\n`);
      return 0;
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
  process.stdout.write(`${JSON.stringify({ ...offer, mode: "offer" })}\n`);
  return 0;
}

if (isDirectCliRun(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
