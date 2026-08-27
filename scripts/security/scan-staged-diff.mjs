#!/usr/bin/env node
// Fail-closed secret scan CLI over the currently staged git diff — the
// deterministic signal both the git pre-commit hook and the fixer invoke.
//
// Exit 0: clean (no hit). Exit non-zero: a hit was found, OR the scan itself
// failed (bad cwd, git error, ...) — both block; a caller distinguishes them
// from the JSON payload's `error` field, never from the exit code alone. Any
// exception thrown here escapes to the isDirectCliRun catch-all below, which
// also exits non-zero — an internal scanner error fails closed by
// construction, not by an explicit try/catch this file has to get right.
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue, runCommand } from "../_cli-primitives.mjs";
import { parseArgs } from "node:util";
import { scanDiffText } from "@dev-loops/core/security/secret-scan";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage: scan-staged-diff.mjs
Fail-closed secret scan over the ADDED lines of the currently staged git
diff (\`git diff --cached\` in the current working directory). On a hit,
reports only file/line/detector-class per finding — NEVER the matched value.

${JQ_OUTPUT_USAGE}`;

const parseError = buildParseError(USAGE);

export function parseScanStagedDiffCliArgs(argv) {
  const options = { help: false };
  const { tokens } = parseArgs({
    args: [...argv],
    options: { help: { type: "boolean", short: "h" }, ...JQ_OUTPUT_PARSE_OPTIONS },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "positional") throw parseError(`Unknown argument: ${token.value}`);
    if (token.kind !== "option") continue;
    if (token.name === "help") { options.help = true; return options; }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  return options;
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, cwd = process.cwd(), env = process.env, gitCommand = "git" } = {}) {
  const options = parseScanStagedDiffCliArgs(argv);
  if (options.help) { stdout.write(`${USAGE}\n`); return { ok: true, help: true }; }

  const { stdout: diffText } = await runCommand(gitCommand, ["diff", "--cached", "--no-color"], { cwd, env });
  const result = scanDiffText(diffText);
  const payload = result.ok
    ? { ok: true, hits: [] }
    : { ok: false, error: "secret_scan_hit", hits: result.findings };
  // A hit (or an unexpected non-ok result) prints to STDERR, mirroring the
  // sibling guards: a git hook's stdout is easy to miss, stderr is what an
  // operator actually reads when a commit is refused.
  process.exitCode = emitResult(payload, { jq: options.jq, silent: options.silent, stdout: payload.ok ? stdout : stderr, stderr });
  return payload;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    // A THROWN error here (a bad cwd, a git failure, a scanner bug) is the
    // "scanner internal error" case — reported distinctly from a hit, but
    // exiting non-zero all the same: fail closed either way.
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
