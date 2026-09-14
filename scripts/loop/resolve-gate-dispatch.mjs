#!/usr/bin/env node
import process from "node:process";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
  loadDevLoopConfig,
  resolveGateDispatchMode,
  resolveLightMode,
  GATE_FULL_LABEL,
} from "@dev-loops/core/config";
import { detectScope } from "./detect-change-scope.mjs";
import { evaluatePrSizeBudget } from "./check-size-budget.mjs";
import { DIFF_ISOLATION_FLAGS, gitEnvWithoutDirOverrides } from "../github/write-gate-context.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { formatCliError } from "../_core-helpers.mjs";

const USAGE = `Usage: resolve-gate-dispatch.mjs --gate <draft|preApproval> [--base <ref>] [--head <ref>] [--full-label] [--inline-severities <csv>]
Decide inline vs full fan-out for a gate from lightMode config + PR facts
(GATE-EXEC-PROPORTIONALITY): under the size cap, ALSO fails closed to full
fan-out when the diff touches a risk path or its size-budget outcome is not a
clean, non-T1 pass — see gate-review-sub-loop-contract.md.
Options:
  --gate <draft|preApproval>   Gate to resolve dispatch for (required)
  --base <ref>                 Base ref for scope detection (default: HEAD~1)
  --head <ref>                 Head ref; ignored unless --base is also set
  --full-label                 PR has the ${GATE_FULL_LABEL} label (forces full fan-out)
  --inline-severities <csv>    Comma-separated severities from the inline pass (escalation phase)
  --help, -h                   Show this help
Output (stdout, JSON):
  { "ok": true, "gate": "draft", "scope": { "ok": true, "filesChanged": 1, "linesChanged": 5 }, "mode": "inline", "reason": "under_threshold", "threshold": { "maxFiles": 2, "maxLines": 20, "riskPaths": [] } }
  { "ok": true, "gate": "draft", "scope": { "ok": true, "filesChanged": 9, "linesChanged": 300 }, "mode": "full_fanout", "reason": "over_threshold", "threshold": { "maxFiles": 2, "maxLines": 20, "riskPaths": [] } }
  { "ok": true, "gate": "draft", "scope": { "ok": true, ... }, "mode": "full_fanout", "reason": "risk_path_touch", "threshold": {...} }
  { "ok": true, "gate": "draft", "scope": { "ok": true, ... }, "mode": "full_fanout", "reason": "size_outcome_escalate"|"size_outcome_block"|"size_outcome_t1", "threshold": {...} }
  { "ok": true, "gate": "draft", "scope": { "ok": false, ... }, "mode": "full_fanout", "reason": "scope_detection_failed", "threshold": null }
Error output (stderr, JSON, the shared CLI error format — see formatCliError):
  { "ok": false, "error": "...", "hint"?: "run with --help for usage" }

${JQ_OUTPUT_USAGE}

Exit codes:
  0   Success
  1   Error
  2   Invalid --jq filter
`;

const VALID_GATES = new Set(["draft", "preApproval"]);

/** Parse a comma-separated severity list. Returns `undefined` when the flag is absent, otherwise a trimmed array (which may be empty `[]` for empty/whitespace-only input). */
export function parseSeverities(csv) {
  if (csv == null) return undefined;
  const list = String(csv)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : [];
}

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      gate: { type: "string" },
      base: { type: "string" },
      head: { type: "string" },
      "full-label": { type: "boolean", default: false },
      "inline-severities": { type: "string" },
      help: { type: "boolean", short: "h" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (!values.gate || !VALID_GATES.has(values.gate)) {
    throw new Error("--gate must be one of: draft, preApproval");
  }
  return {
    gate: values.gate,
    base: values.base ?? null,
    head: values.head ?? null,
    hasFullLabel: Boolean(values["full-label"]),
    inlineFindingSeverities: parseSeverities(values["inline-severities"]),
    jq: values.jq,
    silent: values.silent === true,
  };
}

// Mirrors detectScope's own two-dot range construction (detect-change-scope.mjs)
// so the changed-file list this resolver evaluates the risk-path floor against
// is the SAME diff detectScope already measured filesChanged/linesChanged from
// — never a different (e.g. three-dot merge-base) range that could silently
// disagree with the scope this round already committed to.
function diffRange(base, head) {
  if (base && head) return `${base}..${head}`;
  if (base) return base;
  return "HEAD~1..HEAD";
}

/**
 * List changed files for the same range detectScope measures, isolated from
 * ambient git config the same way write-gate-context.mjs's diff capture is.
 * Returns `null` (never throws) on any git failure — a caller-side ambiguity
 * signal, not a crash: resolveGateDispatchMode fails CLOSED on a non-array
 * changedFiles.
 */
function detectChangedFiles({ base, head, cwd }) {
  try {
    const output = execFileSync(
      "git",
      [...DIFF_ISOLATION_FLAGS, "diff", "--no-ext-diff", "--name-only", diffRange(base, head)],
      { cwd: cwd || undefined, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, env: gitEnvWithoutDirOverrides(), stdio: ["ignore", "pipe", "ignore"] },
    );
    return output.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  } catch {
    return null;
  }
}

export async function run(argv) {
  let opts;
  try {
    opts = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`${formatCliError(err, { usage: USAGE })}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const { config } = await loadDevLoopConfig({ repoRoot: process.cwd() });
    const scope = detectScope({ base: opts.base, head: opts.head });
    // Fail CLOSED on unmeasurable scope: a broken/failed diff must route to the
    // full gate, never silently collapse to inline (which would bypass review).
    if (scope.ok === false) {
      process.exitCode = emitResult({
        ok: true,
        gate: opts.gate,
        scope,
        mode: "full_fanout",
        reason: "scope_detection_failed",
        threshold: null,
      }, { jq: opts.jq, silent: opts.silent });
      return;
    }
    // The GATE-EXEC-PROPORTIONALITY floors (risk-path, size-outcome) only ever
    // change an already-under-cap decision (an over-cap diff is full_fanout
    // regardless of them) — so the extra diff/size-budget reads below run ONLY
    // on a diff that is at least a plausible inline candidate, keeping the
    // over-cap path's I/O cost unchanged.
    const threshold = !opts.hasFullLabel ? resolveLightMode(config) : null;
    const isCandidate = threshold != null
      && Number(scope.filesChanged) <= threshold.maxFiles
      && Number(scope.linesChanged) <= threshold.maxLines;
    let changedFiles;
    let sizeOutcome = null;
    if (isCandidate) {
      changedFiles = detectChangedFiles({ base: opts.base, head: opts.head, cwd: process.cwd() });
      try {
        sizeOutcome = await evaluatePrSizeBudget({
          base: opts.base ?? "HEAD~1",
          head: (opts.base && opts.head) ? opts.head : "HEAD",
          repoRoot: process.cwd(),
        });
      } catch {
        sizeOutcome = null; // fails CLOSED — resolveGateDispatchMode treats null as ambiguous
      }
    }
    const decision = resolveGateDispatchMode(config, opts.gate, {
      scope,
      changedFiles,
      sizeOutcome,
      hasFullLabel: opts.hasFullLabel,
      inlineFindingSeverities: opts.inlineFindingSeverities,
    });
    process.exitCode = emitResult(
      { ok: true, gate: opts.gate, scope, ...decision },
      { jq: opts.jq, silent: opts.silent },
    );
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] && process.argv[1].includes("resolve-gate-dispatch.mjs");
if (isDirectRun) {
  run(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${formatCliError(err)}\n`);
    process.exitCode = 1;
  });
}
