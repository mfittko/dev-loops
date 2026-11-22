#!/usr/bin/env node
/**
 * check-spawn-timeout (input-validation checklist line I1)
 *
 * Flags a `runChild`, `spawnSync` or `execFileSync` call that an added line starts and that passes no
 * `timeout` option, in changed non-test files under `scripts/` and `packages/`. A spawned child without a
 * timeout can hang a lane. Local only: one git diff, no GitHub call.
 *
 * Escape: `spawn-timeout:allow <reason>` on the call line or the line above admits a call that must run
 * without a timeout. A marker without a reason does not count.
 *
 * shortcut: the call arguments are found by counting parentheses, so a parenthesis inside a string or
 * regex literal in the arguments can end the span early; upgrade to a parser if that shows up.
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

export const ESCAPE_MARKER = "spawn-timeout:allow";
const GIT_TIMEOUT_MS = 30_000;
const SCOPE_RE = /^(scripts|packages)\/.+\.(mjs|cjs|js|ts|mts|cts)$/u;
const EXCLUDED_RE = /(^|\/)(node_modules|test|__tests__)\/|\.test\.[mc]?[jt]s$/u;
const CALL_RE = /(?<![\w$.])(runChild|spawnSync|execFileSync)\s*\(/gu;
const REASONED_ALLOW_RE = new RegExp(`${ESCAPE_MARKER}[ \\t]+\\S`, "u");

export const isInScope = (p) => SCOPE_RE.test(p) && !EXCLUDED_RE.test(p);

// The text between the call's parentheses, or null when they never balance.
function callArguments(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")" && (depth -= 1) === 0) return text.slice(openIndex + 1, i);
  }
  return null;
}

/**
 * Pure: `files` is [{ path, content, addedLines: number[] }] (1-based added line numbers at head).
 * Returns { ok, outcome, findings: [{ path, line, call }], reasons }.
 */
export function computeSpawnTimeout({ files = [] } = {}) {
  const findings = [];
  for (const { path, content, addedLines } of files) {
    if (!isInScope(path)) continue;
    const added = new Set(addedLines);
    const lines = content.split("\n");
    const offsets = lines.reduce((acc, line) => [...acc, acc[acc.length - 1] + line.length + 1], [0]);
    for (const match of content.matchAll(CALL_RE)) {
      const line = offsets.findLastIndex((o) => o <= match.index) + 1;
      if (!added.has(line)) continue;
      if (/^\s*(export\s+)?(async\s+)?function\b|^\s*import\b/u.test(lines[line - 1])) continue;
      if (REASONED_ALLOW_RE.test(`${lines[line - 2] ?? ""}\n${lines[line - 1]}`)) continue;
      const args = callArguments(content, match.index + match[0].length - 1);
      if (args !== null && /\btimeout/iu.test(args)) continue;
      findings.push({ path, line, call: match[1] });
    }
  }
  if (!findings.length) return { ok: true, outcome: "pass", findings, reasons: [] };
  const reasons = findings.map((f) => `${f.path}:${f.line}: ${f.call}() passes no timeout option; a hung child blocks the lane. Add a timeout or \`${ESCAPE_MARKER} <reason>\`.`);
  return { ok: false, outcome: "block", findings, reasons };
}

const assertPlausibleRef = (ref, label) => {
  if (typeof ref !== "string" || !ref || ref.startsWith("-") || ref.includes("..")) throw new Error(`${label} must be a plausible git ref (no leading '-', no '..')`);
};

const git = (args, cwd, env) => execFileSync("git", args, { cwd, env: { ...env, GIT_DIR: undefined, GIT_WORK_TREE: undefined }, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], timeout: GIT_TIMEOUT_MS }).toString();

// Added 1-based line numbers per in-scope file from a `--unified=0` diff.
export function parseAddedLines(diffOutput) {
  const byPath = new Map();
  let current = null;
  for (const line of diffOutput.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      current = p.startsWith("b/") && isInScope(p.slice(2)) ? p.slice(2) : null;
      if (current) byPath.set(current, []);
    } else if (current && line.startsWith("@@")) {
      const m = /\+(\d+)(?:,(\d+))?/u.exec(line);
      const start = Number(m[1]);
      for (let i = 0; i < Number(m[2] ?? 1); i += 1) byPath.get(current).push(start + i);
    }
  }
  return byPath;
}

export async function evaluateSpawnTimeout({ base, head = "HEAD", repoRoot = process.cwd(), env = process.env } = {}) {
  assertPlausibleRef(base, "--base");
  assertPlausibleRef(head, "--head");
  const diffOutput = git(["-c", "core.pager=cat", "-c", "diff.renames=true", "diff", "--no-ext-diff", "--unified=0", "--no-color", `${base}...${head}`], repoRoot, env);
  const files = [...parseAddedLines(diffOutput)].map(([path, addedLines]) => ({ path, addedLines, content: git(["show", `${head}:${path}`], repoRoot, env) }));
  return computeSpawnTimeout({ files });
}

const USAGE = `Usage: check-spawn-timeout.mjs --base <ref> [--head <ref>]

Flags a runChild, spawnSync or execFileSync call that a changed non-test file under scripts/ or
packages/ adds without a timeout option. \`${ESCAPE_MARKER} <reason>\` on the call line or the line
above admits a call that must run without one. Makes no GitHub call. Emits pass | block.

Required:
  --base <ref>          Git ref to diff against (git diff <ref>...<head>)

Optional:
  --head <ref>          Git ref for the PR head (default: HEAD)

Exit codes:
   0  pass    1  block    2  argument/usage error

${JQ_OUTPUT_USAGE}`;

const parseError = buildParseError(USAGE);

export function parseCheckSpawnTimeoutCliArgs(argv) {
  const options = { help: false, base: undefined, head: "HEAD" };
  const { tokens } = parseArgs({ args: [...argv], options: { help: { type: "boolean", short: "h" }, base: { type: "string" }, head: { type: "string" }, ...JQ_OUTPUT_PARSE_OPTIONS }, allowPositionals: true, strict: false, tokens: true });
  for (const token of tokens) {
    if (token.kind === "positional") throw parseError(`Unknown argument: ${token.value}`);
    if (token.kind !== "option") continue;
    if (token.name === "help") { options.help = true; return options; }
    if (token.name === "base") { options.base = requireTokenValue(token, parseError); continue; }
    if (token.name === "head") { options.head = requireTokenValue(token, parseError); continue; }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (!options.base) throw parseError("check-spawn-timeout requires --base <ref>");
  return options;
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, repoRoot = process.cwd(), env = process.env } = {}) {
  const options = parseCheckSpawnTimeoutCliArgs(argv);
  if (options.help) { stdout.write(`${USAGE}\n`); return { ok: true, help: true }; }
  const result = await evaluateSpawnTimeout({ base: options.base, head: options.head, repoRoot, env });
  const payload = { ...result, ok: result.outcome === "pass" };
  if (result.outcome !== "pass") payload.error = "spawn_timeout_block";
  process.exitCode = emitResult(payload, { jq: options.jq, silent: options.silent, stdout, stderr });
  return payload;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 2;
  });
}
