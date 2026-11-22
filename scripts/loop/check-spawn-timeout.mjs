#!/usr/bin/env node
/**
 * check-spawn-timeout (input-validation checklist line I1)
 *
 * Flags a `runChild`, `spawnSync` or `execFileSync` call that the diff touches (an added line, or a
 * deletion, inside its argument span) and that passes no effective timeout option, in changed non-test
 * files under `scripts/` and `packages/`. The option key is the one the callee reads: `timeoutMs` for
 * `runChild`, `timeout` for `spawnSync` and `execFileSync`; the literal values 0 and undefined do not
 * count. A spawned child without a timeout can hang a lane. Local only: one git diff, no GitHub call.
 *
 * Escape: `spawn-timeout:allow <reason>` on the call line, or alone on a comment line directly above,
 * admits a call that must run without a timeout. A marker without a word in its reason does not count.
 *
 * Result shape: { ok, outcome: "pass" | "block", findings: [{ path, line, call }], reasons, recovery? }.
 * `recovery` is present on a block only.
 *
 * shortcut: strings, template literals and comments are skipped while counting parentheses, but a regex
 * literal that holds a quote or parenthesis can still end the span early or late; upgrade to a parser if
 * that shows up. Unbalanced or unterminated arguments block.
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
// The reason needs a word character before any comment terminator, so a bare block-comment marker fails.
const REASONED_ALLOW_RE = new RegExp(`${ESCAPE_MARKER}[ \\t]+(?:(?!\\*/)[^\\w\\n])*\\w`, "u");
const COMMENT_ONLY_RE = /^\s*(?:\/\/|\/\*|\*)/u;
// Text before a call that makes it prose (a line comment, a JSDoc body, an open block comment) or the declared name.
const PROSE_PREFIX_RE = /^\s*(?:\/\/|\*(?!\/)|\/\*(?!.*\*\/))/u;
const DECLARED_NAME_PREFIX_RE = /\bfunction\s*\*?\s+$/u;
// The option key each callee reads; a call needs it with a value other than the literal 0 or undefined.
const TIMEOUT_KEY = { runChild: "timeoutMs", spawnSync: "timeout", execFileSync: "timeout" };

export const isInScope = (p) => SCOPE_RE.test(p) && !EXCLUDED_RE.test(p);

const hasTimeoutKey = (key, args) => new RegExp(`(?<![\\w$.])${key}\\s*(?::(?!\\s*(?:0|undefined)\\s*(?:[,}]|$))|(?=[,}]))`, "u").test(args);

// The call's argument text with string, template and comment content blanked, and the index of its closing
// parenthesis; null when the parentheses or a string or comment never close.
function callArguments(text, openIndex) {
  let depth = 0;
  let out = "";
  for (let i = openIndex; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      if (j >= text.length) return null;
      out += `${c} ${c}`;
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      if (nl === -1) return null;
      i = nl - 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) return null;
      i = close + 1;
      out += " ";
    } else if (c === "(") {
      depth += 1;
      if (depth > 1) out += c;
    } else if (c === ")") {
      depth -= 1;
      if (depth === 0) return { text: out, end: i };
      out += c;
    } else if (depth > 0) out += c;
  }
  return null;
}

/**
 * Pure: `files` is [{ path, content, addedLines: number[], deletedAfter?: number[] }] (1-based added line
 * numbers at head; `deletedAfter` holds the head line after which a pure deletion sits).
 * Returns { ok, outcome, findings: [{ path, line, call }], reasons, recovery? }.
 */
export function computeSpawnTimeout({ files = [] } = {}) {
  const findings = [];
  for (const { path, content, addedLines, deletedAfter = [] } of files) {
    if (!isInScope(path)) continue;
    const lines = content.split("\n");
    const offsets = [0];
    for (const line of lines) offsets.push(offsets[offsets.length - 1] + line.length + 1);
    const lineAt = (index) => offsets.findLastIndex((o) => o <= index) + 1;
    for (const match of content.matchAll(CALL_RE)) {
      const line = lineAt(match.index);
      const prefix = lines[line - 1].slice(0, match.index - offsets[line - 1]);
      if (PROSE_PREFIX_RE.test(prefix) || DECLARED_NAME_PREFIX_RE.test(prefix) || /^\s*import\b/u.test(lines[line - 1])) continue;
      const args = callArguments(content, match.index + match[0].length - 1);
      const endLine = args ? lineAt(args.end) : lines.length;
      // A call is touched by an added line in its span or a deletion between two of its lines.
      if (!addedLines.some((n) => n >= line && n <= endLine) && !deletedAfter.some((n) => n >= line && n < endLine)) continue;
      const previous = lines[line - 2] ?? "";
      if (REASONED_ALLOW_RE.test(lines[line - 1]) || (COMMENT_ONLY_RE.test(previous) && REASONED_ALLOW_RE.test(previous))) continue;
      if (args !== null && hasTimeoutKey(TIMEOUT_KEY[match[1]], args.text)) continue;
      findings.push({ path, line, call: match[1] });
    }
  }
  if (!findings.length) return { ok: true, outcome: "pass", findings, reasons: [] };
  const reasons = findings.map((f) => `${f.path}:${f.line}: ${f.call}() passes no \`${TIMEOUT_KEY[f.call]}\` option; a hung child blocks the lane. Add \`${TIMEOUT_KEY[f.call]}\` or \`${ESCAPE_MARKER} <reason>\`.`);
  return { ok: false, outcome: "block", findings, reasons, recovery: `Add the timeout option the call reads (\`timeoutMs\` for runChild, \`timeout\` for spawnSync and execFileSync) to each listed call, or mark it \`${ESCAPE_MARKER} <reason>\`, then rerun the check.` };
}

const assertPlausibleRef = (ref, label) => {
  if (typeof ref !== "string" || !ref || ref.startsWith("-") || ref.includes("..")) throw new Error(`${label} must be a plausible git ref (no leading '-', no '..')`);
};

const git = (args, cwd, env) => {
  try {
    return execFileSync("git", args, { cwd, env: { ...env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_DIFF_OPTS: undefined }, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], timeout: GIT_TIMEOUT_MS }).toString();
  } catch (error) {
    throw new Error(`git ${args.join(" ")} failed: ${(error.stderr?.toString() || error.message).trim()}`, { cause: error });
  }
};

// Added 1-based line numbers and pure-deletion positions per in-scope file from a `--unified=0` diff.
// A file header counts only between its `diff --git` line and its first hunk, so content cannot forge one.
export function parseAddedLines(diffOutput) {
  const byPath = new Map();
  let current = null;
  let inHeader = false;
  for (const line of diffOutput.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      current = null;
    } else if (inHeader && line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      if (p.startsWith('"')) throw new Error(`diff header path stays quoted: ${p}`);
      current = p.startsWith("b/") && isInScope(p.slice(2)) ? p.slice(2) : null;
      if (current) byPath.set(current, { added: [], deletedAfter: [] });
    } else if (line.startsWith("@@")) {
      inHeader = false;
      if (!current) continue;
      const m = /\+(\d+)(?:,(\d+))?/u.exec(line);
      const start = Number(m[1]);
      const count = Number(m[2] ?? 1);
      if (count === 0) byPath.get(current).deletedAfter.push(start);
      for (let i = 0; i < count; i += 1) byPath.get(current).added.push(start + i);
    }
  }
  return byPath;
}

export async function evaluateSpawnTimeout({ base, head = "HEAD", repoRoot = process.cwd(), env = process.env } = {}) {
  assertPlausibleRef(base, "--base");
  assertPlausibleRef(head, "--head");
  // Resolve head once: the diff and every show read the same commit, and the committed copy wins over the working tree.
  const sha = git(["rev-parse", "--verify", `${head}^{commit}`], repoRoot, env).trim();
  const diffOutput = git(["-c", "core.pager=cat", "-c", "diff.renames=true", "-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "--text", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "--inter-hunk-context=0", "--diff-algorithm=myers", "--unified=0", "--no-color", `${base}...${sha}`], repoRoot, env);
  const files = [...parseAddedLines(diffOutput)].map(([path, { added, deletedAfter }]) => ({ path, addedLines: added, deletedAfter, content: git(["show", `${sha}:${path}`], repoRoot, env) }));
  return computeSpawnTimeout({ files });
}

const USAGE = `Usage: check-spawn-timeout.mjs --base <ref> [--head <ref>]

Flags a runChild, spawnSync or execFileSync call that the diff touches (an added line or a deletion
inside its arguments) in a changed non-test file under scripts/ or packages/, when it passes no
effective timeout option: \`timeoutMs\` for runChild, \`timeout\` for spawnSync and execFileSync, with
a value other than 0 or undefined. Other spawn forms are not checked. \`${ESCAPE_MARKER} <reason>\`
on the call line, or alone on a comment line above, admits a call that must run without one.
Makes no GitHub call. Emits { ok, outcome: pass | block, findings, reasons }; a block adds
error: spawn_timeout_block and recovery.

Required:
  --base <ref>          Git ref to diff against (git diff <ref>...<head>)

Optional:
  --head <ref>          Git ref for the PR head (default: HEAD)

Exit codes:
   0  pass    1  block    2  argument/usage error or git failure (for example an unknown ref)

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
  process.exitCode = emitResult(payload, { jq: options.jq, fields: options.fields, silent: options.silent, stdout, stderr });
  return payload;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 2;
  });
}
