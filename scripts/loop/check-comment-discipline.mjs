#!/usr/bin/env node
/**
 * check-comment-discipline (LOCAL-COMMENT-DISCIPLINE, issue #2054)
 *
 * Recurrence guard, comment-side analogue of the coverage-admission rule.
 * Flags newly added runtime-source comments that narrate issue-number
 * chronology or balloon into a design essay, so a cleaned comment state stays
 * clean as it is created. Deterministic, diff-scoped, ADDED-LINES-ONLY: it
 * only ever reads the `+` lines a PR introduces, so it can never flag the
 * pre-existing backlog owned by the comment-cleanup stream.
 *
 * Flag classes (per contiguous span of added comment lines):
 *  1. issue-chronology: the span cites two or more distinct `#NNN` issue
 *     references. A single reference to the authoritative reason is allowed;
 *     a chain is chronology narration.
 *  2. design-essay: the span exceeds the added-comment-block line threshold
 *     (a calibration knob, not a hard invariant).
 *
 * Escape: an added comment line carrying the inline marker
 * `comment-discipline:allow` exempts its whole span, so a genuinely
 * load-bearing exception is retained without weakening the check.
 *
 * Pure computation (no git I/O) lives in `computeCommentDiscipline`; the
 * git-side wrapper is `evaluateCommentDiscipline`, mirroring
 * `evaluateAdrTripwire` in check-adr-tripwire.mjs.
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

// Calibration knob (ponytail: default; raise if long invariant docs trip it).
export const DEFAULT_MAX_ADDED_COMMENT_BLOCK_LINES = 40;
export const ESCAPE_MARKER = "comment-discipline:allow";
const ISSUE_REF_RE = /#\d{1,6}\b/gu;

// Runtime-source code files that carry comments. JSON is excluded (no comment
// syntax); markdown/docs are not code. Test files and generated mirrors are
// excluded below so the guard stays high-precision on runtime source.
const JS_FAMILY_RE = /\.(mjs|cjs|js|ts|mts|cts)$/u;
const SHELL_RE = /\.sh$/u;
const EXCLUDED_PATH_RE = /(^|\/)(node_modules|\.claude|tmp|docs)\//u;
const TEST_FILE_RE = /(^|\/)(test|__tests__)\/|\.test\.[mc]?[jt]s$/u;

function isRuntimeSourceFile(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  if (EXCLUDED_PATH_RE.test(p) || TEST_FILE_RE.test(p)) return false;
  return JS_FAMILY_RE.test(p) || SHELL_RE.test(p);
}

// A comment line, by file kind. Lexical and deliberately simple: JS-family
// lines starting with a comment sigil, shell lines starting with `#` (a
// shebang has no digit after `#` so it never reads as an issue reference).
// ponytail: anchored at line start on purpose. A trailing inline comment
// (issue references after code on the same line) is not scanned; detecting it
// safely means excluding string/URL slash contexts, and agent narration lands
// in own-line comment blocks/JSDoc, so the escape marker + reviewer cover it.
function isCommentLine(text, filePath) {
  const t = text.trim();
  if (t.length === 0) return false;
  if (SHELL_RE.test(filePath)) return t.startsWith("#");
  return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");
}

function countDistinctIssueRefs(text) {
  const refs = new Set(text.match(ISSUE_REF_RE) ?? []);
  return refs.size;
}

/**
 * Compute the comment-discipline outcome for one unified diff. Pure — no git,
 * no fs — so fixtures drive every branch directly.
 *
 * @param {object} input
 * @param {string} [input.diffOutput] — `git diff --unified=0 base...head` text
 * @param {number} [input.maxAddedCommentBlockLines] — design-essay threshold
 */
export function computeCommentDiscipline({
  diffOutput = "",
  maxAddedCommentBlockLines = DEFAULT_MAX_ADDED_COMMENT_BLOCK_LINES,
} = {}) {
  const findings = [];
  let currentFile = null;
  let runtimeFile = false;
  let span = null; // { file, lines: [], escaped }

  const flushSpan = () => {
    if (span === null) return;
    const text = span.lines.join("\n");
    if (!span.escaped) {
      if (countDistinctIssueRefs(text) >= 2) {
        findings.push({ type: "issue-chronology", path: span.file, snippet: span.lines[0].trim().slice(0, 120) });
      }
      if (span.lines.length > maxAddedCommentBlockLines) {
        findings.push({ type: "design-essay", path: span.file, lines: span.lines.length, snippet: span.lines[0].trim().slice(0, 120) });
      }
    }
    span = null;
  };

  for (const line of diffOutput.split("\n")) {
    // Treat `+++ ` as a file header only when it parses to a real diff target
    // (`/dev/null` or a `b/`-prefixed path); an added source line whose content
    // begins with `++ ` also starts with `+++ ` and must fall through to the
    // added-line branch, not reset the current file.
    if (line.startsWith("+++ ") && (line.slice(4).trim() === "/dev/null" || line.slice(4).trim().startsWith("b/"))) {
      flushSpan();
      const p = line.slice(4).trim();
      currentFile = p === "/dev/null" ? null : p.replace(/^b\//u, "");
      runtimeFile = currentFile !== null && isRuntimeSourceFile(currentFile);
      continue;
    }
    if (line.startsWith("---") || line.startsWith("@@") || line.startsWith("diff ")) {
      flushSpan();
      continue;
    }
    // Added content line (a `+` that is not the `+++` file header).
    if (line.startsWith("+")) {
      const content = line.slice(1);
      if (runtimeFile && isCommentLine(content, currentFile)) {
        if (span === null) span = { file: currentFile, lines: [], escaped: false };
        span.lines.push(content);
        if (content.includes(ESCAPE_MARKER)) span.escaped = true;
        continue;
      }
      flushSpan();
      continue;
    }
    // Context or removed line breaks a contiguous added-comment span.
    flushSpan();
  }
  flushSpan();

  if (findings.length === 0) {
    return { ok: true, outcome: "pass", findings, reasons: [] };
  }
  const reasons = findings.map((f) => f.type === "issue-chronology"
    ? `${f.path}: added comment cites an issue-number chronology chain (LOCAL-COMMENT-DISCIPLINE): "${f.snippet}"`
    : `${f.path}: added comment block is ${f.lines} lines, over the ${maxAddedCommentBlockLines}-line design-essay threshold (LOCAL-COMMENT-DISCIPLINE): "${f.snippet}"`);
  reasons.push(
    `Comment discipline blocked: an added runtime-source comment violates LOCAL-COMMENT-DISCIPLINE. State a current invariant, not agent-move narration or issue chronology; add \`${ESCAPE_MARKER}\` to the comment to admit a load-bearing exception.`,
  );
  return { ok: false, outcome: "block", findings, reasons };
}

function assertPlausibleRef(ref, label) {
  if (typeof ref !== "string" || ref.length === 0 || ref.startsWith("-") || ref.includes("..")) {
    throw new Error(`${label} must be a plausible git ref (no leading '-', no '..')`);
  }
}

/**
 * Evaluate comment discipline against a locally-resolvable base...head diff.
 * Never runs `git fetch`; three-dot diff scopes to what this branch added.
 */
export async function evaluateCommentDiscipline({
  base,
  head = "HEAD",
  repoRoot = process.cwd(),
  env = process.env,
  maxAddedCommentBlockLines = DEFAULT_MAX_ADDED_COMMENT_BLOCK_LINES,
} = {}) {
  assertPlausibleRef(base, "--base");
  assertPlausibleRef(head, "--head");
  const gitEnv = { ...env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };
  // Pin the diff body/prefixes/algorithm and disable external diff drivers so
  // the analyzed bytes are environment-independent (the repo's established
  // isolation set, mirroring check-size-budget.mjs / write-gate-context.mjs).
  const isolation = [
    "-c", "color.ui=false",
    "-c", "color.diff=false",
    "-c", "core.pager=cat",
    "-c", "diff.noprefix=false",
    "-c", "diff.mnemonicPrefix=false",
    // diff.renames=true keeps a renamed+edited file an R pair (only its edited
    // lines are `+`); with renames off it shows as D+A and the whole re-added
    // file reads as added, which would flag its pre-existing comments.
    "-c", "diff.renames=true",
    "-c", "diff.algorithm=myers",
    "-c", "core.autocrlf=false",
  ];
  const diffOutput = execFileSync(
    "git",
    [...isolation, "diff", "--no-ext-diff", "--unified=0", "--no-color", `${base}...${head}`],
    { cwd: repoRoot, env: gitEnv, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
  ).toString();
  return computeCommentDiscipline({ diffOutput, maxAddedCommentBlockLines });
}

const USAGE = `Usage: check-comment-discipline.mjs --base <ref> [--head <ref>]

Fail-closed comment-discipline guard (LOCAL-COMMENT-DISCIPLINE, issue #2054).
Diff-scoped and added-lines-only: flags newly added runtime-source comments
that cite a #NNN issue-number chronology chain (two or more distinct refs) or
exceed the design-essay comment-block threshold. An added comment line
carrying \`${ESCAPE_MARKER}\` exempts its span. Never reads pre-existing
comments. Emits pass | block.

Required:
  --base <ref>          Git ref to diff against (git diff <ref>...<head>)

Optional:
  --head <ref>          Git ref for the PR head (default: HEAD)

Exit codes:
   0  pass    1  block    2  argument/usage error

${JQ_OUTPUT_USAGE}`;

const parseError = buildParseError(USAGE);

export function parseCheckCommentDisciplineCliArgs(argv) {
  const options = { help: false, base: undefined, head: "HEAD" };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      base: { type: "string" },
      head: { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "positional") throw parseError(`Unknown argument: ${token.value}`);
    if (token.kind !== "option") continue;
    if (token.name === "help") { options.help = true; return options; }
    if (token.name === "base") { options.base = requireTokenValue(token, parseError); continue; }
    if (token.name === "head") { options.head = requireTokenValue(token, parseError); continue; }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (!options.base) throw parseError("check-comment-discipline requires --base <ref>");
  return options;
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, repoRoot = process.cwd(), env = process.env } = {}) {
  const options = parseCheckCommentDisciplineCliArgs(argv);
  if (options.help) { stdout.write(`${USAGE}\n`); return { ok: true, help: true }; }
  const result = await evaluateCommentDiscipline({ base: options.base, head: options.head, repoRoot, env });
  const payload = { ...result, ok: result.outcome === "pass" };
  if (result.outcome !== "pass") payload.error = "comment_discipline_block";
  process.exitCode = emitResult(payload, { jq: options.jq, silent: options.silent, stdout, stderr });
  return payload;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 2;
  });
}
