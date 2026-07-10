#!/usr/bin/env node
/**
 * check-retro-tooling
 *
 * Deterministic, dependency-free verifier for the internal-tooling-only rule
 * (issue #982). Given a transcript of the shell commands the agent ran during a
 * dev-loop run, it detects AGENT-LEVEL raw escape-hatch calls that should have
 * gone through internal dev-loops tooling:
 *   - `gh ...` (incl. `gh api`, `gh ... --jq`)
 *   - `python` / `python3`
 *   - `node -e` / `node --eval`
 *
 * These three are the same breach: reaching past the dev-loops tooling to read
 * or parse tool output with a raw call. The verifier returns the list of
 * violations so the retrospective author can record them in
 * `behavioralReview.rawCallViolations` and set `behavioralReview.internalToolingOnly`.
 *
 * Input source (how the harness feeds it):
 *   Newline-delimited shell commands — one top-level command per line — as the
 *   agent actually invoked them. Pass via a file (`--transcript <path>`) or pipe
 *   on stdin. Each line is one Bash-tool invocation's command string.
 *
 * ALLOWED (NOT a violation):
 *   - dev-loops subcommands and `node scripts/....mjs` invocations. Those scripts
 *     legitimately call gh/GraphQL/etc. internally — that IS the tooling.
 *   - A small explicit allowlist of write-ops that have no internal wrapper today:
 *     `gh pr merge`, `gh pr ready`. Plus belt-and-suspenders
 *     entries that DO have wrappers — `gh issue edit` (scripts/github/edit-issue.mjs)
 *     and `gh label create` (scripts/github/create-label.mjs) — kept so a bare
 *     invocation surfaced from the wrapper's own subprocess is not a false violation.
 *     All are recorded as `allowedWriteOps` rather than violations so the gate is not
 *     blocked forever on an unavoidable gap. Document/close the gap with a wrapper
 *     to remove the no-wrapper entries from the allowlist.
 *
 * VIOLATION (agent-level raw call):
 *   - `gh ...` at the start of a command segment (start of line, or after
 *     `&&`, `||`, `|`, `;`) that is not in the write-op allowlist.
 *   - `python` / `python3` at the start of a command segment.
 *   - `node -e` / `node --eval` (inline eval) at the start of a command segment.
 *
 * Head normalization (before classifying a segment, fail-closed):
 *   - strips leading `NAME=value ` env-assignment prefixes (`GH_TOKEN=x gh api`)
 *   - strips a leading wrapper binary from {sudo, env, xargs, time, nice, command}
 *     and re-classifies the remainder (`sudo gh api`, `xargs gh api`, `env gh api`)
 *   - reduces a path-prefixed binary to its basename (`./node_modules/.bin/gh`,
 *     `/usr/bin/python3`) so the real tool is matched.
 *
 * Known limitations (honest):
 *   - Segment splitting is a simple top-level split on `&&`, `||`, `|`, `;` and
 *     does NOT fully parse shell quoting/substitution. A `;`/`|` inside a quoted
 *     argument can over-report (flags a harmless inner token). It catches the
 *     common raw-call forms (incl. the env/wrapper/path-prefixed ones above), but
 *     deeply obfuscated calls — command substitution `$(...)`, aliases, `eval` —
 *     may evade it. Prefer single-line, single-purpose commands in transcripts.
 */
import { readFileSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";
import { isDirectCliRun } from "@dev-loops/core/cli/helpers";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";

const USAGE = `Usage: node scripts/loop/check-retro-tooling.mjs [--transcript <path>] [--json]

Reads a newline-delimited transcript of agent shell commands (from --transcript
or stdin) and reports agent-level raw gh/python/node -e calls (internal-tooling-only
rule, issue #982).

Options:
  --transcript <path>   File of newline-delimited commands (default: read stdin)
  --json                Emit machine-readable JSON (default: human summary)

${JQ_OUTPUT_USAGE}
(--jq/--silent only apply together with --json; the default text output is unaffected.)

Exit codes:
  0  No violations
  1  One or more violations found
  2  Argument/runtime error, or invalid --jq filter`;

/**
 * Write-ops recorded distinctly (as allowedWriteOps, not violations) so the gate
 * is not blocked forever on an unavoidable gap. Most have no internal wrapper yet;
 * a couple DO have wrappers and are kept belt-and-suspenders (see below).
 * Keep this set SMALL and explicit; remove a no-wrapper entry once a wrapper exists.
 * @type {ReadonlyArray<RegExp>}
 */
const ALLOWED_WRITE_OPS = Object.freeze([
  /^gh\s+pr\s+merge\b/,
  /^gh\s+pr\s+ready\b/,
  // `gh issue edit` (scripts/github/edit-issue.mjs) and `gh label create`
  // (scripts/github/create-label.mjs) both HAVE wrappers; these entries are
  // belt-and-suspenders so a bare invocation (e.g. surfaced from the wrapper's
  // own subprocess) classifies as an allowed write-op, not a violation.
  /^gh\s+issue\s+edit\b/,
  /^gh\s+label\s+create\b/,
]);

/** Split a command line into top-level segments on &&, ||, |, ;. */
function splitSegments(line) {
  return line
    .split(/&&|\|\||\||;/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Wrapper binaries whose first argument is the real command to classify. */
const WRAPPER_BINARIES = new Set(["sudo", "env", "xargs", "time", "nice", "command"]);

/**
 * Strip prefixes that hide the real command head, fail-closed (over-report is
 * fine, under-report is the bug):
 *   - leading `NAME=value ` env-assignment tokens (any number)
 *   - leading wrapper binaries (`sudo`, `env`, `xargs`, ...) — recurse on the rest
 *   - a path-prefixed binary (`./x/gh`, `/usr/bin/python3`) → reduce head to its basename
 * Returns the segment with a bare, classifiable command head.
 */
function normalizeSegmentHead(segment) {
  let s = segment.trim();
  // (a) strip leading env-assignment tokens: NAME=value. The value may be
  //   unquoted (`X=1`) or a single/double-quoted string that itself contains
  //   spaces (`X="a b"`); match the quoted form first so the space inside the
  //   quotes is not mistaken for the token separator (would under-report).
  const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+(?=\S)/;
  while (ENV_ASSIGN.test(s)) {
    s = s.replace(ENV_ASSIGN, "");
  }
  // (c) reduce a path-prefixed head to its basename so `.../gh` → `gh`
  s = s.replace(/^(\S*\/)([^/\s]+)/, "$2");
  // (b) strip a leading wrapper binary, then re-normalize the remainder
  const head = s.split(/\s+/, 1)[0];
  if (WRAPPER_BINARIES.has(head)) {
    const rest = s.slice(head.length).trim();
    if (rest.length > 0) return normalizeSegmentHead(rest);
  }
  return s;
}

/**
 * Classify a single command segment.
 * @returns {{ kind: "violation"|"allowedWriteOp"|"clean", tool?: string }}
 */
function classifySegment(rawSegment) {
  const segment = normalizeSegmentHead(rawSegment);
  // `node scripts/....mjs` (or any script path) is allowed tooling; only inline
  // eval forms are violations. Check node first so script invocations pass.
  if (/^node\b/.test(segment)) {
    // Inline eval (`-e`/`--eval`) is a violation only before the script path:
    // once a non-flag token (the script) appears, a later `--eval` is just a
    // script argument, not Node's inline-eval mode (avoids false positives).
    const tokens = segment.split(/\s+/).slice(1);
    for (const tok of tokens) {
      if (tok === "-e" || tok === "--eval" || /^--eval=/.test(tok)) {
        return { kind: "violation", tool: "node -e" };
      }
      if (!tok.startsWith("-")) break; // script path reached
    }
    return { kind: "clean" };
  }
  if (/^gh\b/.test(segment)) {
    if (ALLOWED_WRITE_OPS.some((re) => re.test(segment))) {
      return { kind: "allowedWriteOp", tool: "gh" };
    }
    return { kind: "violation", tool: "gh" };
  }
  if (/^python3?\b/.test(segment)) {
    return { kind: "violation", tool: /^python3\b/.test(segment) ? "python3" : "python" };
  }
  return { kind: "clean" };
}

/**
 * Analyze a transcript of newline-delimited shell commands.
 *
 * @param {string} transcript
 * @returns {{ violations: string[], allowedWriteOps: string[], internalToolingOnly: boolean }}
 */
export function analyzeTranscript(transcript) {
  const violations = [];
  const allowedWriteOps = [];
  const lines = String(transcript ?? "").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    for (const segment of splitSegments(line)) {
      const result = classifySegment(segment);
      if (result.kind === "violation") {
        violations.push(`${result.tool}: ${segment}`);
      } else if (result.kind === "allowedWriteOp") {
        allowedWriteOps.push(segment);
      }
    }
  }
  return { violations, allowedWriteOps, internalToolingOnly: violations.length === 0 };
}

function parseCliArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        transcript: { type: "string" },
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

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

async function run(argv, { stdout, stderr }) {
  const values = parseCliArgs(argv);
  if (values.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  const transcript = values.transcript
    ? readFileSync(values.transcript, "utf8")
    : readStdin();

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
      const usage = error instanceof Error && typeof error.usage === "string" ? `\n${error.usage}` : "";
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}${usage}\n`);
      process.exitCode = 2;
    },
  );
}
