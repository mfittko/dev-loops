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
 *     `gh pr merge`, `gh pr ready`, `gh issue create`, `gh issue edit`. These are
 *     recorded as `allowedWriteOps` rather than violations so the gate is not
 *     blocked forever on an unavoidable gap. Document/close the gap with a wrapper
 *     to remove them from the allowlist.
 *
 * VIOLATION (agent-level raw call):
 *   - `gh ...` at the start of a command segment (start of line, or after
 *     `&&`, `||`, `|`, `;`) that is not in the write-op allowlist.
 *   - `python` / `python3` at the start of a command segment.
 *   - `node -e` / `node --eval` (inline eval) at the start of a command segment.
 *
 * Known limitations (honest):
 *   - Segment splitting is a simple top-level split on `&&`, `||`, `|`, `;`. It
 *     does NOT parse quoting, so a `;`/`|` INSIDE a quoted argument splits the
 *     line. In practice this only ever over-reports (flags a harmless inner
 *     token), never under-reports a real top-level raw call, which is the
 *     fail-closed direction we want.
 *   - `gh`/`python` appearing purely as a substring inside a quoted argument to an
 *     allowed command may be flagged if it follows a `|`/`;`/`&&` separator inside
 *     that quote. Prefer single-line, single-purpose commands in transcripts.
 */
import { readFileSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";
import { isDirectCliRun } from "@dev-loops/core/cli/helpers";

const USAGE = `Usage: node scripts/loop/check-retro-tooling.mjs [--transcript <path>] [--json]

Reads a newline-delimited transcript of agent shell commands (from --transcript
or stdin) and reports agent-level raw gh/python/node -e calls (internal-tooling-only
rule, issue #982).

Options:
  --transcript <path>   File of newline-delimited commands (default: read stdin)
  --json                Emit machine-readable JSON (default: human summary)

Exit codes:
  0  No violations
  1  One or more violations found
  2  Argument/runtime error`;

/**
 * Write-ops that currently have no internal dev-loops wrapper. Recorded
 * distinctly so the gate is not blocked forever on an unavoidable gap.
 * Keep this set SMALL and explicit; remove an entry once a wrapper exists.
 * @type {ReadonlyArray<RegExp>}
 */
const ALLOWED_WRITE_OPS = Object.freeze([
  /^gh\s+pr\s+merge\b/,
  /^gh\s+pr\s+ready\b/,
  /^gh\s+issue\s+create\b/,
  /^gh\s+issue\s+edit\b/,
]);

/** Split a command line into top-level segments on &&, ||, |, ;. */
function splitSegments(line) {
  return line
    .split(/&&|\|\||\||;/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Classify a single command segment.
 * @returns {{ kind: "violation"|"allowedWriteOp"|"clean", tool?: string }}
 */
function classifySegment(segment) {
  // `node scripts/....mjs` (or any script path) is allowed tooling; only inline
  // eval forms are violations. Check node first so script invocations pass.
  if (/^node\b/.test(segment)) {
    if (/^node\s+(?:[^|;&]*\s)?(?:-e|--eval)\b/.test(segment)) {
      return { kind: "violation", tool: "node -e" };
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
    stdout.write(`${JSON.stringify({ ok: true, internalToolingOnly, rawCallViolations: violations, allowedWriteOps })}\n`);
  } else if (internalToolingOnly) {
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
