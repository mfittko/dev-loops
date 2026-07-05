#!/usr/bin/env node
/**
 * Validate that a PR body carries the invariants required to serve as the
 * lightweight spec-of-record (issue #1025): Objective/why, in-scope, explicit
 * non-goals, testable Acceptance criteria, Definition of done, and Open
 * questions/risks.
 *
 * Thin CLI wrapper (parallel to detect-issue-refinement-artifact.mjs): fetches
 * the PR body via `gh pr view <n> --json body` and runs the shared pure
 * validator `validatePrBodySpec` (reuses issue-refinement-artifact markdown
 * logic — no parallel validator). Fails closed (non-zero + per-section reason)
 * when any invariant is missing.
 */
import { readFile } from "node:fs/promises";
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { parseArgs } from "node:util";
import { validatePrBodySpec } from "@dev-loops/core/loop/issue-refinement-artifact";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage:
  validate-pr-body-spec.mjs --repo <owner/name> --pr <number> [--expected-issue <n>]
  validate-pr-body-spec.mjs --input <path> [--expected-issue <n>]
Validate that a PR body carries the lightweight spec-of-record invariants
(Objective/why, In scope, Explicit non-goals, testable Acceptance criteria,
Definition of done, Open questions/risks, and a GitHub closing-keyword issue
reference such as \`Closes #123\`).
Required (exactly one):
  --repo <owner/name> --pr <number>   Fetch the PR body via gh and validate it
  --input <path>                      Path to a JSON file with { "body": "..." }
                                      (optional "repo" and "pr" fields are echoed
                                      back in the result when present)
Optional:
  --expected-issue <n>                Positive integer; the referenced closing
                                      issue(s) must include this number, else
                                      "closes_wrong_issue".
Success output (stdout, JSON):
  {
    "ok": true | false,
    "checker": "validate-pr-body-spec",
    "repo": "owner/name" | null,
    "pr": 123 | null,
    "errors": [ { "code": "missing_...", "message": "..." } ],
    "sections": [...],
    "acItems": [...],
    "dodItems": [...],
    "closesIssues": [...]
  }
Exit: 0 when every invariant is present; 1 (fail closed) when any is missing.
Error output (stderr, JSON):
  { "ok": false, "error": "...", "usage": "..." }
${JQ_OUTPUT_USAGE}`.trim();

const parseError = buildParseError(USAGE);

export function parseValidatePrBodySpecCliArgs(argv) {
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
    input: undefined,
    expectedIssue: undefined,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      input: { type: "string" },
      "expected-issue": { type: "string" },
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
      options.repo = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "pr") {
      const value = requireTokenValue(token, parseError);
      if (!/^\d+$/.test(value) || Number(value) === 0) {
        throw parseError("--pr must be a positive integer");
      }
      options.pr = Number(value);
      continue;
    }
    if (token.name === "input") {
      options.input = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "expected-issue") {
      const value = requireTokenValue(token, parseError);
      if (!/^\d+$/.test(value) || Number(value) === 0) {
        throw parseError("--expected-issue must be a positive integer");
      }
      options.expectedIssue = Number(value);
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.help) {
    return options;
  }
  const hasInput = typeof options.input === "string" && options.input.length > 0;
  const hasAnyRemote = (typeof options.repo === "string" && options.repo.length > 0) || Number.isInteger(options.pr);
  const hasRemotePair = typeof options.repo === "string" && options.repo.length > 0 && Number.isInteger(options.pr);
  // --input and the remote mode are mutually exclusive input sources: a stray
  // --repo/--pr alongside --input must fail closed, not be silently ignored.
  if (hasInput && hasAnyRemote) {
    throw parseError("--input is mutually exclusive with --repo/--pr; provide exactly one input mode");
  }
  if (hasInput === hasRemotePair) {
    throw parseError("Provide exactly one of --input <path> or --repo <owner/name> --pr <number>");
  }
  return options;
}

async function fetchPrBody({ repo, pr }, { env = process.env, ghCommand = "gh" } = {}) {
  const result = await runChild(
    ghCommand,
    ["pr", "view", String(pr), "--repo", repo, "--json", "body"],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  const payload = parseJsonText(result.stdout, { label: "gh pr view" });
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid gh pr view payload: missing body");
  }
  return typeof payload.body === "string" ? payload.body : "";
}

async function loadInputPayload(inputPath) {
  const text = await readFile(inputPath, "utf8");
  const payload = parseJsonText(text, { label: `input file ${inputPath}` });
  if (!payload || typeof payload !== "object") {
    throw new Error(`Input file ${inputPath} must be a JSON object`);
  }
  return payload;
}

export async function validatePrBodySpecFromOptions(options, { env = process.env, ghCommand = "gh" } = {}) {
  if (typeof options.input === "string" && options.input.length > 0) {
    const payload = await loadInputPayload(options.input);
    const body = typeof payload.body === "string" ? payload.body : "";
    const repo = typeof payload.repo === "string" ? payload.repo : options.repo ?? null;
    const pr = Number.isInteger(payload.pr) ? payload.pr : options.pr ?? null;
    return { ...validatePrBodySpec({ body, expectedIssue: options.expectedIssue ?? null }), repo, pr };
  }
  parseRepoSlug(options.repo);
  const body = await fetchPrBody({ repo: options.repo, pr: options.pr }, { env, ghCommand });
  return {
    ...validatePrBodySpec({ body, expectedIssue: options.expectedIssue ?? null }),
    repo: options.repo,
    pr: options.pr,
  };
}

export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, env = process.env, ghCommand = "gh" } = {},
) {
  let options;
  try {
    options = parseValidatePrBodySpecCliArgs(argv);
  } catch (error) {
    stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    return 1;
  }
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const result = await validatePrBodySpecFromOptions(options, { env, ghCommand });
    // Fail closed: a body missing any invariant maps result.ok=false to exit 1.
    return emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
  } catch (error) {
    stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  const code = await runCli();
  if (code !== 0) {
    process.exitCode = code;
  }
}
