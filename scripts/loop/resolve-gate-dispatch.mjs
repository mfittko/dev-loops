#!/usr/bin/env node
import process from "node:process";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
  loadDevLoopConfig,
  resolveReviewProportionality,
  resolveLightMode,
  GATE_FULL_LABEL,
} from "@dev-loops/core/config";
import { detectScope } from "./detect-change-scope.mjs";
import { evaluatePrSizeBudget } from "./check-size-budget.mjs";
import { DIFF_ISOLATION_FLAGS, gitEnvWithoutDirOverrides } from "../github/write-gate-context.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { formatCliError } from "../_core-helpers.mjs";

const USAGE = `Usage: resolve-gate-dispatch.mjs --gate <draft|preApproval> [--base <ref>] [--head <ref>] [--full-label] [--inline-severities <csv>]
Compute the gate-coordinator-owned deterministic review-proportionality plan
(GATE-EXEC-PROPORTIONALITY, resolveReviewProportionality): mode (inline vs
full fan-out) + resolved angle set + fan-out grouping, from lightMode config +
PR facts. Under the size cap, ALSO fails closed to full_fanout DISPATCH (keeping the
matched tier's reduced set, or the mandatory-floor-plus-justified-lenses best-effort
set — never the full untiered pool, except the gate:full escape hatch) when the diff
touches a risk path, its size-budget outcome is not a clean non-T1 pass, or the diff
is unclassifiable — see gate-review-sub-loop-contract.md.
Options:
  --gate <draft|preApproval>   Gate to resolve dispatch for (required)
  --base <ref>                 Base ref for scope detection (default: HEAD~1)
  --head <ref>                 Head ref; ignored unless --base is also set
  --full-label                 PR has the ${GATE_FULL_LABEL} label (forces full fan-out)
  --inline-severities <csv>    Comma-separated severities from the inline pass (escalation phase)
  --help, -h                   Show this help
Output (stdout, JSON):
  { "ok": true, "gate": "draft", "scope": { "ok": true, "filesChanged": 1, "linesChanged": 5 }, "mode": "inline", "reason": "under_threshold", "threshold": { "maxFiles": 2, "maxLines": 20, "riskPaths": [] }, "angles": [...], "groups": [...], "floors": { "sizeCap": false, "riskPath": false, "sizeOutcome": false, "ambiguity": false, "unclassifiable": false } }
  { "ok": true, "gate": "draft", "scope": { "ok": true, "filesChanged": 9, "linesChanged": 300 }, "mode": "full_fanout", "reason": "over_threshold", "threshold": { "maxFiles": 2, "maxLines": 20, "riskPaths": [] }, "angles": [...], "groups": [...], "floors": {...} }
  { "ok": true, "gate": "draft", "scope": { "ok": true, ... }, "mode": "full_fanout", "reason": "risk_path_touch", "threshold": {...}, "angles": [...], "groups": [...], "floors": {...} }
  { "ok": true, "gate": "draft", "scope": { "ok": true, ... }, "mode": "full_fanout", "reason": "size_outcome_escalate"|"size_outcome_block"|"size_outcome_t1"|"size_outcome_unavailable"|"unclassifiable_diff", "threshold": {...}, "angles": [...], "groups": [...], "floors": {...} }
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
    const threshold = !opts.hasFullLabel ? resolveLightMode(config) : null;
    const isCandidate = threshold != null
      && Number(scope.filesChanged) <= threshold.maxFiles
      && Number(scope.linesChanged) <= threshold.maxLines;
    // The changed-file list feeds BOTH the risk-path floor AND resolveGateTier's
    // diff-classification (which the composer needs for its angle set — an
    // over-cap diff can still legitimately match a reduced tier, and an
    // unclassifiable diff must force full_fanout DISPATCH while keeping the
    // mandatory-floor best-effort angle set, never the full untiered pool) —
    // so it is always read, unlike the heavier size-budget evaluation below.
    const changedFiles = detectChangedFiles({ base: opts.base, head: opts.head, cwd: process.cwd() });
    // The size-budget outcome only ever changes an already-under-cap decision
    // (an over-cap diff is full_fanout regardless of it), so this heavier read
    // runs ONLY on a diff that is at least a plausible inline candidate,
    // keeping the over-cap path's extra I/O cost bounded to one cheap diff.
    // KNOWN, bounded range asymmetry: `changedFiles` above is the two-dot
    // `base..head` diff (diffRange, matching detectScope/`scope` exactly).
    // evaluatePrSizeBudget below is the SHARED size-budget reader
    // (check-size-budget.mjs) and always diffs `base...head` (the three-dot
    // merge-base form) — its own contract, reused as-is everywhere else it is
    // called (never re-derived here) rather than duplicating its diff-capture
    // internals for a narrower two-dot variant. When `base` has moved forward
    // independently of `head` (commits landed on base's branch after this
    // round's diff started), the two ranges genuinely describe different
    // diffs and this round's plan CAN disagree with itself (e.g. angles
    // resolved against one range, mode against the other). This is bounded,
    // not fail-open: the merge-gate re-verify (detect-checkpoint-evidence.mjs)
    // NEVER trusts this round's recorded plan — it independently RECOMPUTES
    // every floor from its OWN merge-base diff at merge time — so a
    // coordinator/merge-gate range mismatch here can only cost an extra
    // reject-and-redo round-trip, never let a genuinely risky diff merge on a
    // stale or lenient coordinator decision. A future unification would read both
    // facts from ONE captured diff object (mirroring write-gate-context.mjs's
    // build-once bundle) rather than two independent git reads.
    let sizeOutcome = null;
    if (isCandidate) {
      try {
        sizeOutcome = await evaluatePrSizeBudget({
          base: opts.base ?? "HEAD~1",
          head: (opts.base && opts.head) ? opts.head : "HEAD",
          repoRoot: process.cwd(),
        });
      } catch {
        sizeOutcome = null; // fails CLOSED — the composer treats null as ambiguous
      }
    }
    // GATE-EXEC-PROPORTIONALITY: the composer is the ONE place mode, the
    // provisional angle set, and grouping are combined. Its no-tier set is a
    // file-kind-based lower bound of write-gate-context.mjs's authoritative
    // category-aware set, except that gate:full returns the full static pool
    // here. Both entry points still share this composer's floor determination.
    const decision = resolveReviewProportionality(config, opts.gate, {
      scope,
      changedFiles,
      sizeOutcome,
      hasFullLabel: opts.hasFullLabel,
      inlineFindingSeverities: opts.inlineFindingSeverities,
    });
    process.exitCode = emitResult(
      { ok: true, gate: opts.gate, scope, mode: decision.mode, reason: decision.reason, threshold, angles: decision.angles, groups: decision.groups, floors: decision.floors },
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
