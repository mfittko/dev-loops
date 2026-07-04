#!/usr/bin/env node
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue, runCommand } from "../_cli-primitives.mjs";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";

const USAGE = `Usage: pre-write-remote-freshness-guard.mjs --branch <name>\nRefresh remote branch state before starting local file writes.\n\n${JQ_OUTPUT_USAGE}`;
const parseError = buildParseError(USAGE);

export function parseRemoteFreshnessGuardCliArgs(argv) {
  const options = { help: false, branch: undefined };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      branch: { type: "string" },
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
    if (token.name === "jq") { options.jq = requireTokenValue(token, parseError); continue; }
    if (token.name === "silent") { options.silent = true; continue; }
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.branch === undefined) throw parseError("--branch <name> is required");
  return options;
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, cwd = process.cwd(), env = process.env, gitCommand = "git" } = {}) {
  const options = parseRemoteFreshnessGuardCliArgs(argv);
  if (options.help) { stdout.write(`${USAGE}\n`); return { ok: true, help: true }; }
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
