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

  // -C --find-copies-harder: detect a staged file that is a copy of EXISTING (already-committed,
  // already-scanned) content — even unmodified content outside this diff — and diff it against
  // that source instead of showing the whole file as newly "added". Without this, vendoring/
  // bundling a verbatim copy of an already-safe file (e.g. the Claude plugin's scripts-root
  // bundle, issue #2123) re-flags every one of its pre-existing findings as if they were new,
  // for content that was already reviewed at its canonical path. This does NOT weaken detection:
  // a copy that actually differs from its source still shows those differing lines as added, and
  // every added line is still scanned exactly as before.
  //
  // .claude/node_modules/ is excluded outright: it is a byte-reproducible mirror of published npm
  // packages (yaml/zod/@dev-loops/core), enforced by the generate-claude-assets `--check`, whose
  // canonical sources (`node_modules/`, `packages/core/src/`) the scanner already never sees or
  // whose authored copy it scans directly. Copy-detection cannot rescue it — the vendored deps'
  // source lives under gitignored `node_modules/`, so there is no committed original to match
  // against, and third-party lexer/token constants read as high-entropy false positives. Excluding
  // it mirrors the existing posture of never scanning `node_modules/`, not a new gap in coverage.
  const { stdout: diffText } = await runCommand(
    gitCommand,
    ["diff", "--cached", "-C", "--find-copies-harder", "--no-color", "--", ".", ":(exclude).claude/node_modules"],
    { cwd, env },
  );
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
