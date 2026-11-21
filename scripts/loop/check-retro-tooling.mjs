#!/usr/bin/env node
/**
 * check-retro-tooling
 *
 * Deterministic, dependency-free verifier for the internal-tooling-only rule.
 * Given a transcript of the shell commands the agent ran during a
 * dev-loop run, it detects AGENT-LEVEL raw escape-hatch calls that should have
 * gone through internal dev-loops tooling:
 *   - `gh ...` (incl. `gh api`, `gh ... --jq`)
 *   - `python` / `python3`
 *   - the OPS-NO-INLINE-INTERPRETER forms (tool `inline-interpreter`)
 *
 * These three are the same breach: reaching past the dev-loops tooling to read
 * or parse tool output with a raw call. The verifier returns the list of
 * violations so the retrospective author can record them in
 * `behavioralReview.rawCallViolations` and set `behavioralReview.internalToolingOnly`.
 *
 * Input source (how the harness feeds it):
 *   Newline-delimited shell commands — one top-level command per line — as the
 *   agent actually invoked them, or a Claude Code session transcript (JSONL) whose
 *   Bash tool_use commands are extracted. Pass either form via a file
 *   (`--transcript <path>`) or pipe it on stdin; both paths run the same extraction.
 *   Each line is one Bash-tool invocation's command string.
 *
 * ALLOWED (NOT a violation):
 *   - dev-loops subcommands and `node scripts/....mjs` invocations. Those scripts
 *     legitimately call gh/GraphQL/etc. internally — that IS the tooling.
 *   - A small explicit allowlist of write-ops that have no internal wrapper today:
 *     `gh pr ready`. This is recorded as `allowedWriteOps` rather
 *     than a violation so the gate is not blocked forever on an unavoidable gap.
 *     (`gh pr merge` was removed once its wrapper — scripts/github/merge-pr.mjs —
 *     shipped, so a raw `gh pr merge` is now a flagged violation per
 *     RAW-GH-PR-MERGE-BYPASS.)
 *     Once an op gains a sanctioned wrapper it is removed from this allowlist so a
 *     raw agent-level call is flagged (the analyzer only ever sees agent Bash-tool
 *     commands, never a wrapper's internal subprocess, so no false positive results).
 *
 * VIOLATION (agent-level raw call):
 *   - `gh ...` at the start of a command segment (start of line, or after
 *     `&&`, `||`, `|`, `;`) that is not in the write-op allowlist.
 *   - `python` / `python3` at the start of a command segment.
 *   - `inline-interpreter`: a command the Bash gate denies under OPS-NO-INLINE-INTERPRETER, or a ceiling case
 *     it allows (a form inside quotes, a substitution, a payload or a heredoc body, a pipe into an interpreter,
 *     or input the tokenizer marks incomplete), from the shared `inlineInterpreterVerdict`. One entry per command.
 *
 * Head normalization (before classifying a segment, fail-closed):
 *   - strips leading `NAME=value ` env-assignment prefixes (`GH_TOKEN=x gh api`)
 *   - strips a leading wrapper binary from {sudo, env, xargs, time, nice, command}
 *     and re-classifies the remainder (`sudo gh api`, `xargs gh api`, `env gh api`)
 *   - reduces a path-prefixed binary to its basename (`./node_modules/.bin/gh`,
 *     `/usr/bin/python3`) so the real tool is matched.
 *
 * Known limitations (honest):
 *   - Segment splitting uses the shared `tokenizeShellCommand` (quote-aware), so a `;`/`|`
 *     inside a quoted argument does not start a segment. A line the tokenizer cannot
 *     close falls back to a plain top-level split on `&&`, `||`, `|`, `;`. It catches the
 *     common raw-call forms (incl. the env/wrapper/path-prefixed ones above), but
 *     deeply obfuscated calls — aliases, `eval` with a variable payload — may evade it. Payload
 *     words (the text after `eval` or a `-c` flag) and substitution segments are split too. Prefer single-line, single-purpose commands in transcripts.
 */
import { readFileSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";
import { isDirectCliRun } from "@dev-loops/core/cli/helpers";
import { inlineInterpreterVerdict, isPayloadWord, stripLeadingWrappers, tokenizeShellCommand } from "@dev-loops/core/loop/bash-command-classify";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";

const MAX_JOIN_LINES = 200;

const USAGE = `Usage: node scripts/loop/check-retro-tooling.mjs [--transcript <path>]... [--json]

Reads a newline-delimited transcript of agent shell commands, or Claude Code
session transcripts (JSONL), from each --transcript or stdin and reports agent-level
raw gh and python calls (internal-tooling-only rule, issue #982), plus every
OPS-NO-INLINE-INTERPRETER form and ceiling case as inline-interpreter.

Options:
  --transcript <path>   Repeatable. A file of newline-delimited commands, or a Claude Code session
                        transcript (JSONL) whose Bash tool commands are extracted. Default: read stdin
  --json                Emit machine-readable JSON (default: human summary)

${JQ_OUTPUT_USAGE}
(--jq/--silent only apply together with --json; the default text output is unaffected.)

Exit codes:
  0  No violations
  1  One or more violations found
  2  Argument/runtime error, unreadable or empty input, or invalid --jq filter`;

/**
 * Write-ops recorded distinctly (as allowedWriteOps, not violations) so the gate
 * is not blocked forever on an unavoidable gap. These have no internal wrapper yet.
 * Keep this set SMALL and explicit; remove an entry once a wrapper exists so a raw
 * agent-level call is flagged (as `gh issue create`/`edit`, `gh label create` now
 * are — their wrappers live under scripts/github/).
 * @type {ReadonlyArray<RegExp>}
 */
const ALLOWED_WRITE_OPS = Object.freeze([
  // `gh pr merge` is NO LONGER allowlisted (RAW-GH-PR-MERGE-BYPASS): it now has a
  // sanctioned wrapper (scripts/github/merge-pr.mjs), so a raw agent-level
  // `gh pr merge` is flagged as a violation directing the caller to the wrapper. The analyzer only
  // ever sees the agent's own top-level Bash commands, never merge-pr.mjs's
  // internal subprocess, so removing it produces no false positive.
  /^gh\s+pr\s+ready\b/,
]);

/**
 * Split a command line into top-level segments with the shared tokenizer, so a separator inside a quoted argument
 * (`--notes "11 were node -e; python3 -c denied"`) never starts a segment. A line the tokenizer cannot close
 * (a transcript entry such as `don't merge yet`) falls back to the plain split on &&, ||, |, ;.
 */
function splitSegments(line) {
  const tok = tokenizeShellCommand(line);
  // Segments inside `$(...)`/backticks run too, so each substitution's segments are traversed like top-level ones (offsets index LINE).
  const walk = (segments) => segments.filter((s) => s.words.length > 0).flatMap((s) => [line.slice(s.words[0].start, s.words.at(-1).end), ...s.words.filter((w, k) => isPayloadWord(s.words, k)).flatMap((w) => splitSegments(w.value)), ...s.words.flatMap((w) => w.subs.flatMap((sub) => walk(sub.segments)))]);
  const parts = tok.incomplete ? line.split(/&&|\|\||\||;/g) : walk(tok.segments);
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Classify a single command segment for the raw gh and python calls (inline-interpreter forms are reported per command).
 * @returns {{ kind: "violation"|"allowedWriteOp"|"clean", tool?: string }}
 */
function classifySegment(rawSegment) {
  const segment = stripLeadingWrappers(rawSegment);
  if (/^gh\b/.test(segment)) {
    if (ALLOWED_WRITE_OPS.some((re) => re.test(segment))) {
      return { kind: "allowedWriteOp", tool: "gh" };
    }
    return { kind: "violation", tool: "gh" };
  }
  // an inline python form is already reported as inline-interpreter
  if (/^python3?\b/.test(segment) && inlineInterpreterVerdict(rawSegment) === "allow") {
    return { kind: "violation", tool: /^python3\b/.test(segment) ? "python3" : "python" };
  }
  return { kind: "clean" };
}

// collapseCommand's marker line for a command holding a heredoc it cannot prove to be data.
const UNPROVEN_HEREDOC = "\u0000unproven-heredoc:";

/**
 * Analyze one whole command: an `inline-interpreter` violation for every form the Bash gate denies and every ceiling
 * case it allows (OPS-NO-INLINE-INTERPRETER, `inlineInterpreterVerdict`), plus the raw gh and python calls per segment.
 * @param {string} command
 * @returns {{ violations: string[], allowedWriteOps: string[] }}
 */
export function analyzeCommand(command) {
  const violations = inlineInterpreterVerdict(command) === "allow" ? [] : [`inline-interpreter: ${command}`];
  const allowedWriteOps = [];
  for (const segment of splitSegments(command)) {
    const result = classifySegment(segment);
    if (result.kind === "violation") {
      violations.push(`${result.tool}: ${segment}`);
    } else if (result.kind === "allowedWriteOp") {
      allowedWriteOps.push(segment);
    }
  }
  return { violations, allowedWriteOps };
}

/**
 * Analyze a transcript of newline-delimited shell commands. Lines that continue an incomplete command are joined to it.
 *
 * @param {string} transcript
 * @returns {{ violations: string[], allowedWriteOps: string[], internalToolingOnly: boolean }}
 */
export function analyzeTranscript(transcript) {
  const violations = [];
  const allowedWriteOps = [];
  const lines = String(transcript ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith(UNPROVEN_HEREDOC)) {
      violations.push(`unproven heredoc: ${line.slice(UNPROVEN_HEREDOC.length)}`);
      continue;
    }
    // A multi-line command (a heredoc body, a quoted message across lines) is one entry: join lines until the tokenizer reads it completely.
    // One line never holds a heredoc body, so a heredoc operator opens a multi-line command too.
    // shortcut: a line that never closes stays a single entry, but a later unpaired apostrophe can close it and absorb the lines between; upgrade to a delimited transcript format if that misfires.
    const tok = tokenizeShellCommand(line);
    if (tok.incomplete || tok.segments.some((s) => s.heredocs.length > 0)) {
      // the join window is capped so an unclosed line costs a bounded number of re-tokenizations
      for (let j = i + 1; j < Math.min(lines.length, i + MAX_JOIN_LINES); j++) {
        const joined = lines.slice(i, j + 1).join("\n").trim();
        if (!tokenizeShellCommand(joined).incomplete) { line = joined; i = j; break; }
      }
    }
    const result = analyzeCommand(line);
    violations.push(...result.violations);
    allowedWriteOps.push(...result.allowedWriteOps);
  }
  return { violations, allowedWriteOps, internalToolingOnly: violations.length === 0 };
}

/**
 * A Claude Code session transcript is JSONL; its Bash tool_use inputs are the commands. A line that is
 * not a JSON object stays a plain command line, so a newline-delimited transcript passes unchanged.
 */
export function extractBashCommands(text) {
  return String(text ?? "").split(/\r?\n/).flatMap((line) => {
    if (!line.trimStart().startsWith("{")) return [line];
    let entry;
    try { entry = JSON.parse(line); } catch { return [line]; }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) return [];
    return content.filter((part) => part?.type === "tool_use" && part.name === "Bash" && typeof part.input?.command === "string").map((part) => collapseCommand(part.input.command));
  }).join("\n");
}

// A trailing `\` continues the line only when the tokenizer still sees it as a word: a comment (full-line or trailing) swallows it.
function continues(line) {
  const words = tokenizeShellCommand(line).segments.at(-1)?.words;
  return Boolean(words?.length) && /(?:^|[^\\])(?:\\\\)*\\$/.test(words.at(-1).raw); // an even run of backslashes is escaped backslashes, not a continuation
}

/**
 * Reduce one multi-line Bash command to its logical lines: a trailing `\` joins the next line, and the body of a data
 * heredoc (the host is cat, tee or git commit) is dropped with its delimiter line, so body text never reads as a command.
 * A heredoc fed to any other host (bash, sh, python) is reported as an unproven heredoc, as is any incompletely tokenized command holding `<<`.
 * Heredocs come from tokenizeShellCommand, which is quote-aware and reads `$(( ))` as arithmetic.
 * A command whose later logical line starts with `#` is reported as an unproven heredoc, because the line analyzer cannot tell a comment from text inside a quoted argument.
 * shortcut: a quoted multi-line argument still splits per line; upgrade when a real session shows it.
 */
function collapseCommand(command) {
  const tok = tokenizeShellCommand(command);
  let text = command;
  // Fail closed: an unterminated heredoc runs to end of input and its body may expand, so any incomplete parse holding `<<` is reported.
  if (tok.incomplete && command.includes("<<")) return `${UNPROVEN_HEREDOC}${command.split("\n")[0]}`;
  if (!tok.incomplete) {
    const dropped = tok.segments.flatMap((seg) => dataHeredocs(seg, tok.segments.length === 1));
    // Fail closed: a closed heredoc that is not provably data (any host, quoted or not, at any substitution depth) is never proven clean.
    // The shell may expand its body, and the line analyzer cannot tell a literal `#` from a comment there, so the command is reported.
    const allHeredocs = (segments) => segments.flatMap((seg) => [...seg.heredocs, ...seg.words.flatMap((w) => w.subs.flatMap((sub) => allHeredocs(sub.segments)))]);
    if (allHeredocs(tok.segments).some((h) => h.closed && !dropped.includes(h))) return `${UNPROVEN_HEREDOC}${command.split("\n")[0]}`;
    for (const h of dropped.sort((x, y) => y.bodyStart - x.bodyStart)) {
      // An empty body with an empty delimiter puts bodyEnd on the delimiter line's own newline; any other bodyEnd precedes the delimiter line.
      const end = text.indexOf("\n", h.delimiter === "" && h.bodyEnd === h.bodyStart ? h.bodyEnd : h.bodyEnd + 1);
      // A placeholder body and the delimiter line stay so the heredoc remains closed and non-empty (an empty body is an inline-interpreter ceiling case) for the line analyzer.
      text = text.slice(0, h.bodyStart) + "x\n" + h.delimiter + (end === -1 ? "" : text.slice(end));
    }
  }
  // Fail closed: a `#` after `$(` or a backtick (data heredoc bodies already dropped) may be a literal inside a substitution, not a comment; the line splitter cannot tell. Coarse on purpose.
  if (/(?:\$\(|`)[\s\S]*#/.test(text)) return `${UNPROVEN_HEREDOC}${command.split("\n")[0]}`;
  const out = [];
  let joined = "";
  for (const line of text.split(/\r?\n/)) {
    joined += line;
    if (joined.endsWith("\\") && continues(joined)) { joined = `${joined.slice(0, -1)} `; continue; }
    out.push(joined);
    joined = "";
  }
  if (joined) out.push(joined);
  // Fail closed: a later logical line that starts with `#` may be text inside a quoted argument, and the line analyzer would skip a call on it. Coarse on purpose.
  if (out.slice(1).some((l) => l.trim().startsWith("#"))) return `${UNPROVEN_HEREDOC}${command.split("\n")[0]}`;
  return out.join("\n");
}

/**
 * The closed heredocs of SEG whose body is data. Mirrors the shared dataHeredocs rule in bash-command-classify (not exported):
 * a bare cat, tee or git commit head with no env-assignment, substitution, process-substitution or `-c`/alias word, no pipe onward,
 * and a quoted delimiter or a body with no `$(`, backtick or `${ `. A cat or tee counts only as the lone segment, because a later segment may run the file it writes.
 */
function dataHeredocs(seg, alone) {
  const [head, sub] = seg.words.map((w) => w.value);
  const host = ((head === "cat" || head === "tee") && alone) || (head === "git" && sub === "commit" && !seg.words.some((w) => /^(?:-c|--config)|alias\./i.test(w.value)));
  if (!host || seg.pipedOut || seg.words.some((w) => /^[A-Za-z_]\w*=/.test(w.raw) || /[<>]\(/.test(w.raw) || /[<>]\(/.test(w.value))) return [];
  const isData = (h) => h.closed && (h.quoted || !/\$\(|`|\$\{[\s|]/.test(h.body.replace(/\\\n/g, "")));
  const subs = seg.words.flatMap((w) => w.subs);
  if (subs.length === 0) return seg.heredocs.filter(isData);
  // `git commit -m "$(cat <<'EOF' ... EOF)"`: one substitution holding one bare, substitution-free cat segment is data, as in the shared rule
  const [inner] = subs[0].segments;
  if (head !== "git" || subs.length !== 1 || subs[0].segments.length !== 1 || inner.pipedOut || inner.words[0]?.value !== "cat" || inner.words.some((w) => w.subs.length > 0 || />|[<>]\(/.test(w.raw))) return [];
  return inner.heredocs.filter(isData);
}

function parseCliArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        transcript: { type: "string", multiple: true },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        ...JQ_OUTPUT_PARSE_OPTIONS,
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw Object.assign(new Error(err instanceof Error ? err.message : String(err)), { usage: USAGE });
  }
  return values;
}

async function readStdin(stdin) {
  try {
    const chunks = [];
    for await (const chunk of stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    return Buffer.concat(chunks).toString("utf8");
  } catch (err) {
    throw new Error(`failed to read stdin: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

export async function run(argv, { stdout, stderr, stdin = process.stdin }) {
  const values = parseCliArgs(argv);
  if (values.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  const raw = values.transcript ? values.transcript.map((file) => readFileSync(file, "utf8")).join("\n") : await readStdin(stdin);
  // Empty means no input at all; a session with no Bash commands extracts to nothing and is clean.
  if (raw.trim().length === 0) throw new Error("empty transcript");
  const transcript = extractBashCommands(raw);

  const { violations, allowedWriteOps, internalToolingOnly } = analyzeTranscript(transcript);

  if (values.json) {
    const payload = { ok: internalToolingOnly, internalToolingOnly, rawCallViolations: violations, allowedWriteOps };
    return emitResult(payload, { jq: values.jq, silent: values.silent, stdout, stderr });
  }
  if (internalToolingOnly) {
    stdout.write(`internalToolingOnly: true — no agent-level raw gh/python/node -e calls found.\n`);
    if (allowedWriteOps.length > 0) {
      stdout.write(`Allowed write-ops (no wrapper yet): ${allowedWriteOps.length}\n`);
    }
  } else {
    stderr.write(`internalToolingOnly: false — ${violations.length} raw-call violation(s):\n`);
    for (const v of violations) stderr.write(`  - ${v}\n`);
  }
  return internalToolingOnly ? 0 : 1;
}

if (isDirectCliRun(import.meta.url)) {
  run(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr }).then(
    (code) => { process.exitCode = typeof code === "number" ? code : 0; },
    (error) => {
      // Deliberately out of formatCliError's scope (same reasoning as
      // scripts/docs/validate-links.mjs): this tool's error output is
      // human-readable text (message + usage body), not the JSON
      // { ok, error, hint } envelope AC5's short-error contract targets.
      const usage = error instanceof Error && typeof error.usage === "string" ? `\n${error.usage}` : "";
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}${usage}\n`);
      process.exitCode = 2;
    },
  );
}
