#!/usr/bin/env node
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { parsePositiveInteger, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
const USAGE = `Usage: manage-sub-issues.mjs <command> --repo <owner/name> --issue <number> [options]
Deterministic helper for reading, linking, ordering, and verifying GitHub sub-issue trees.
Commands:
  list    List sub-issues of a parent issue
  add     Add a child issue as a sub-issue of a parent
  reorder Set the execution order of sub-issues
  verify  Verify the sub-issue tree state matches expectations
Common required options:
  --repo <owner/name>      Repository slug (e.g. owner/repo)
  --issue <number>         Parent issue number
add options:
  --child <number>         Child issue number to add as sub-issue
reorder options:
  --order <n1,n2,...>      Comma-separated issue numbers in the desired execution order (highest priority first)
verify options:
  --expected <n1,n2,...>   Comma-separated expected sub-issue numbers
  --ordered                Also verify that order matches exactly (optional)
Success output (stdout, JSON):
  list:
    { "ok": true, "repo": "owner/name", "issue": N, "command": "list",
      "subIssues": [{ "number": M, "title": "...", "state": "open"|"closed", "id": ID }, ...] }
  add:
    { "ok": true, "repo": "owner/name", "issue": N, "command": "add", "child": M }
  reorder:
    { "ok": true, "repo": "owner/name", "issue": N, "command": "reorder", "order": [n1, n2, ...] }
  verify:
    { "ok": true, "repo": "owner/name", "issue": N, "command": "verify",
      "verified": true|false, "expected": [...], "actual": [...],
      "missing": [...], "unexpected": [...] }
    When --ordered is set and sets match but order differs, also includes "orderMismatch": true
Error output (stderr, JSON):
  Argument/usage errors:
    { "ok": false, "error": "...", "usage": "..." }
  gh/runtime failures:
    { "ok": false, "error": "..." }
${JQ_OUTPUT_USAGE}`.trim();
const parseError = buildParseError(USAGE);
function parseIssueList(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw parseError("Issue list must be a non-empty comma-separated list of positive integers");
  }
  const parts = value.split(",").map((s) => s.trim());
  if (parts.some((p) => !/^\d+$/.test(p) || Number(p) === 0)) {
    throw parseError("Issue list must contain only positive integers");
  }
  const numbers = parts.map(Number);
  const seen = new Set();
  for (const n of numbers) {
    if (seen.has(n)) {
      throw parseError(`Duplicate issue number in list: ${n}`);
    }
    seen.add(n);
  }
  return numbers;
}
const VALID_COMMANDS = ["list", "add", "reorder", "verify"];
export function parseManageSubIssuesCliArgs(argv) {
  const args = [...argv];
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return { help: true };
  }
  const command = args.shift();
  if (!VALID_COMMANDS.includes(command)) {
    throw parseError(`Unknown command: ${command}. Valid commands: ${VALID_COMMANDS.join(", ")}`);
  }
  const options = {
    help: false,
    command,
    repo: undefined,
    issue: undefined,
    child: undefined,
    order: undefined,
    expected: undefined,
    ordered: false,
  };
  const { tokens } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      issue: { type: "string" },
      child: { type: "string" },
      order: { type: "string" },
      expected: { type: "string" },
      ordered: { type: "boolean" },
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
    if (token.name === "issue") {
      options.issue = parsePositiveInteger(requireTokenValue(token, parseError), "Issue number", parseError);
      continue;
    }
    if (token.name === "child") {
      options.child = parsePositiveInteger(requireTokenValue(token, parseError), "Issue number", parseError);
      continue;
    }
    if (token.name === "order") {
      options.order = parseIssueList(requireTokenValue(token, parseError));
      continue;
    }
    if (token.name === "expected") {
      options.expected = parseIssueList(requireTokenValue(token, parseError));
      continue;
    }
    if (token.name === "ordered") {
      options.ordered = true;
      continue;
    }
    if (token.name === "jq") {
      options.jq = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "silent") {
      options.silent = true;
      continue;
    }
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined || options.issue === undefined) {
    throw parseError("Both --repo <owner/name> and --issue <number> are required");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  if (command === "list") {
    if (options.child !== undefined) {
      throw parseError("The list command does not accept --child");
    }
    if (options.order !== undefined) {
      throw parseError("The list command does not accept --order");
    }
    if (options.expected !== undefined) {
      throw parseError("The list command does not accept --expected");
    }
    if (options.ordered) {
      throw parseError("The list command does not accept --ordered");
    }
  }
  if (command === "add") {
    if (options.child === undefined) {
      throw parseError("The add command requires --child <number>");
    }
    if (options.order !== undefined) {
      throw parseError("The add command does not accept --order");
    }
    if (options.expected !== undefined) {
      throw parseError("The add command does not accept --expected");
    }
    if (options.ordered) {
      throw parseError("The add command does not accept --ordered");
    }
  }
  if (command === "reorder") {
    if (options.order === undefined) {
      throw parseError("The reorder command requires --order <n1,n2,...>");
    }
    if (options.child !== undefined) {
      throw parseError("The reorder command does not accept --child");
    }
    if (options.expected !== undefined) {
      throw parseError("The reorder command does not accept --expected");
    }
    if (options.ordered) {
      throw parseError("The reorder command does not accept --ordered");
    }
  }
  if (command === "verify") {
    if (options.expected === undefined) {
      throw parseError("The verify command requires --expected <n1,n2,...>");
    }
    if (options.child !== undefined) {
      throw parseError("The verify command does not accept --child");
    }
    if (options.order !== undefined) {
      throw parseError("The verify command does not accept --order");
    }
  }
  return options;
}
function buildSubIssuesListPath(owner, name, issue) {
  return `repos/${owner}/${name}/issues/${issue}/sub_issues`;
}
function buildIssueGetPath(owner, name, issue) {
  return `repos/${owner}/${name}/issues/${issue}`;
}
function buildSubIssueAddPath(owner, name, issue) {
  return `repos/${owner}/${name}/issues/${issue}/sub_issues`;
}
function buildSubIssueReorderPath(owner, name, issue) {
  return `repos/${owner}/${name}/issues/${issue}/sub_issues/priority`;
}
function normalizeSubIssue(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const id = raw.id;
  const number = raw.number;
  const title = typeof raw.title === "string" ? raw.title : "";
  const state = typeof raw.state === "string" ? raw.state.toLowerCase() : null;
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }
  if (!Number.isInteger(number) || number <= 0) {
    return null;
  }
  if (state !== "open" && state !== "closed") {
    return null;
  }
  return { id, number, title, state };
}

/**
 * Call gh api with optional JSON parsing.
 * @param {boolean} [expectJson=true] - When false, skip JSON parsing (for empty-body responses like PATCH reorder).
 */
async function ghApi(ghCommand, args, env, expectJson = true) {
  const result = await runChild(ghCommand, ["api", ...args], env);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh api command failed: ${detail}`);
  }
  if (!expectJson) {
    return null;
  }
  return parseJsonText(result.stdout);
}
async function listSubIssues(owner, name, issue, { env, ghCommand }) {
  const path = buildSubIssuesListPath(owner, name, issue);
  const payload = await ghApi(ghCommand, [path], env);
  if (!Array.isArray(payload)) {
    throw new Error("Invalid sub-issues payload: expected an array");
  }
  const subIssues = [];
  for (const raw of payload) {
    const normalized = normalizeSubIssue(raw);
    if (normalized) {
      subIssues.push(normalized);
    }
  }
  return subIssues;
}
async function getIssueId(owner, name, issueNumber, { env, ghCommand }) {
  const path = buildIssueGetPath(owner, name, issueNumber);
  const payload = await ghApi(ghCommand, [path], env);
  const id = payload?.id;
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Could not resolve id for issue #${issueNumber}`);
  }
  return id;
}
export async function runList({ repo, issue }, { env = process.env, ghCommand = "gh" } = {}) {
  const { owner, name } = parseRepoSlug(repo);
  const subIssues = await listSubIssues(owner, name, issue, { env, ghCommand });
  return {
    ok: true,
    repo,
    issue,
    command: "list",
    subIssues: subIssues.map(({ number, title, state, id }) => ({ number, title, state, id })),
  };
}
export async function runAdd({ repo, issue, child }, { env = process.env, ghCommand = "gh" } = {}) {
  const { owner, name } = parseRepoSlug(repo);
  const childId = await getIssueId(owner, name, child, { env, ghCommand });
  const path = buildSubIssueAddPath(owner, name, issue);
  await ghApi(ghCommand, ["-X", "POST", path, "-F", `sub_issue_id=${childId}`], env, false);
  return {
    ok: true,
    repo,
    issue,
    command: "add",
    child,
  };
}
export async function runReorder({ repo, issue, order }, { env = process.env, ghCommand = "gh" } = {}) {
  const { owner, name } = parseRepoSlug(repo);
  const subIssues = await listSubIssues(owner, name, issue, { env, ghCommand });
  const idByNumber = new Map(subIssues.map((si) => [si.number, si.id]));
  for (const n of order) {
    if (!idByNumber.has(n)) {
      throw new Error(`Issue #${n} is not a sub-issue of #${issue}`);
    }
  }
  const reorderPath = buildSubIssueReorderPath(owner, name, issue);
  let afterId = 0;
  for (const n of order) {
    const subIssueId = idByNumber.get(n);
    const fieldArgs = ["-F", `sub_issue_id=${subIssueId}`, "-F", `after_id=${afterId}`];
    await ghApi(ghCommand, ["-X", "PATCH", reorderPath, ...fieldArgs], env, false);
    afterId = subIssueId;
  }
  return {
    ok: true,
    repo,
    issue,
    command: "reorder",
    order,
  };
}
export function computeVerifyResult({ repo, issue, expected, ordered, subIssues }) {
  const actualNumbers = subIssues.map((si) => si.number);
  const expectedCounts = new Map();
  const actualCounts = new Map();
  for (const number of expected) {
    expectedCounts.set(number, (expectedCounts.get(number) ?? 0) + 1);
  }
  for (const number of actualNumbers) {
    actualCounts.set(number, (actualCounts.get(number) ?? 0) + 1);
  }
  const allNumbers = new Set([...expectedCounts.keys(), ...actualCounts.keys()]);
  const missing = [];
  const unexpected = [];
  for (const number of allNumbers) {
    const expectedCount = expectedCounts.get(number) ?? 0;
    const actualCount = actualCounts.get(number) ?? 0;
    if (actualCount < expectedCount) {
      missing.push(...Array(expectedCount - actualCount).fill(number));
    }
    if (actualCount > expectedCount) {
      unexpected.push(...Array(actualCount - expectedCount).fill(number));
    }
  }
  if (missing.length > 0 || unexpected.length > 0) {
    return {
      ok: true,
      repo,
      issue,
      command: "verify",
      verified: false,
      expected,
      actual: actualNumbers,
      missing,
      unexpected,
    };
  }
  if (ordered) {
    const orderMismatch = !expected.every((number, index) => actualNumbers[index] === number);
    if (orderMismatch) {
      return {
        ok: true,
        repo,
        issue,
        command: "verify",
        verified: false,
        expected,
        actual: actualNumbers,
        missing: [],
        unexpected: [],
        orderMismatch: true,
      };
    }
  }
  return {
    ok: true,
    repo,
    issue,
    command: "verify",
    verified: true,
    expected,
    actual: actualNumbers,
    missing: [],
    unexpected: [],
  };
}
export async function runVerify(
  { repo, issue, expected, ordered },
  { env = process.env, ghCommand = "gh" } = {},
) {
  const { owner, name } = parseRepoSlug(repo);
  const subIssues = await listSubIssues(owner, name, issue, { env, ghCommand });
  return computeVerifyResult({ repo, issue, expected, ordered, subIssues });
}
export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, env = process.env, ghCommand = "gh" } = {},
) {
  const options = parseManageSubIssuesCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const { command, repo, issue, child, order, expected, ordered } = options;
  let result;
  if (command === "list") {
    result = await runList({ repo, issue }, { env, ghCommand });
  } else if (command === "add") {
    result = await runAdd({ repo, issue, child }, { env, ghCommand });
  } else if (command === "reorder") {
    result = await runReorder({ repo, issue, order }, { env, ghCommand });
  } else if (command === "verify") {
    result = await runVerify({ repo, issue, expected, ordered }, { env, ghCommand });
  }
  process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}
if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
