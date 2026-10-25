#!/usr/bin/env node
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue, runCommand } from "../_cli-primitives.mjs";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage: pre-write-remote-freshness-guard.mjs (--branch <name> | --base <name>)\nRefresh remote branch state before starting local file writes (--branch), or check that HEAD contains the current origin/<base> (--base; exits nonzero with base_stale_integrate_first when stale).\n\n${JQ_OUTPUT_USAGE}`;
const parseError = buildParseError(USAGE);
const lines = (s) => s.split(/\r?\n/u).map((l) => l.trim()).filter((l) => l.length > 0);

/**
 * Stale-base preflight (issue 2885): fetch origin/<base> with an explicit refspec and report
 * commits on it that HEAD lacks. `foreignFiles` are files whose content differs from origin/<base>
 * (two-dot) but that the branch never touched (three-dot), the stale-base signature.
 */
export async function checkBaseFreshness({ base, cwd = process.cwd(), env = process.env, gitCommand = "git" }) {
  const git = async (args) => lines((await runCommand(gitCommand, args, { cwd, env })).stdout);
  try {
    await runCommand(gitCommand, ["fetch", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`], { cwd, env });
  } catch (error) {
    return { ok: false, error: "base_fetch_failed", base, message: error?.message ?? String(error) };
  }
  const newerCommits = await git(["log", `HEAD..origin/${base}`, "--oneline"]);
  if (newerCommits.length === 0) return { ok: true, status: "base_current", base };
  const touched = new Set(await git(["diff", "--name-only", `origin/${base}...HEAD`]));
  const foreignFiles = (await git(["diff", "--name-only", `origin/${base}..HEAD`])).filter((f) => !touched.has(f));
  return {
    ok: false,
    error: "base_stale_integrate_first",
    base,
    newerCommits,
    foreignFiles,
    remedy: `Merge origin/${base} into the branch via scripts/loop/resolve-pr-conflicts.mjs. Never rebase a pushed branch. Never force-push. Push the merge, re-derive spec identity, and re-validate at the new head.`,
  };
}

export function parseRemoteFreshnessGuardCliArgs(argv) {
  const options = { help: false, branch: undefined, base: undefined };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      branch: { type: "string" },
      base: { type: "string" },
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
    if (token.name === "help") { options.help = true; return options; }
    if (token.name === "branch") { options.branch = requireTokenValue(token, parseError, { flagPattern: /^-/u }); continue; }
    if (token.name === "base") { options.base = requireTokenValue(token, parseError, { flagPattern: /^-/u }); continue; }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.branch !== undefined && options.base !== undefined) throw parseError("--branch and --base are mutually exclusive");
  if (options.branch === undefined && options.base === undefined) throw parseError("--branch <name> or --base <name> is required");
  return options;
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, cwd = process.cwd(), env = process.env, gitCommand = "git" } = {}) {
  const options = parseRemoteFreshnessGuardCliArgs(argv);
  if (options.help) { stdout.write(`${USAGE}\n`); return { ok: true, help: true }; }
  if (options.base !== undefined) {
    const p = await checkBaseFreshness({ base: options.base, cwd, env, gitCommand });
    process.exitCode = emitResult(p, { jq: options.jq, silent: options.silent, stdout: p.ok ? stdout : stderr, stderr });
    if (!p.ok) process.exitCode = process.exitCode || 1;
    return p;
  }
  await runCommand(gitCommand, ["fetch", "origin", options.branch], { cwd, env });
  const { stdout: logOutput } = await runCommand(gitCommand, ["log", `HEAD..origin/${options.branch}`, "--oneline"], { cwd, env });
  const newCommits = logOutput.split(/\r?\n/u).map(l => l.trim()).filter(l => l.length > 0);
  if (newCommits.length === 0) {
    const p = { ok: true, status: "up_to_date" };
    process.exitCode = emitResult(p, { jq: options.jq, silent: options.silent, stdout, stderr });
    return p;
  }
  const p = { ok: false, error: "remote_ahead", newCommits };
  process.exitCode = emitResult(p, { jq: options.jq, silent: options.silent, stdout: stderr, stderr });
  return p;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch(e => { process.stderr.write(`${formatCliError(e)}\n`); process.exitCode = 1; });
}
