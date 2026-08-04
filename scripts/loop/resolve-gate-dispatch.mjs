#!/usr/bin/env node
import process from "node:process";
import { parseArgs } from "node:util";
import {
  loadDevLoopConfig,
  resolveGateDispatchMode,
  GATE_FULL_LABEL,
} from "@dev-loops/core/config";
import { detectScope } from "./detect-change-scope.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { formatCliError } from "../_core-helpers.mjs";

const USAGE = `Usage: resolve-gate-dispatch.mjs --gate <draft|preApproval> [--base <ref>] [--head <ref>] [--full-label] [--inline-severities <csv>]
Decide inline vs full fan-out for a gate from lightMode config + PR facts.
Options:
  --gate <draft|preApproval>   Gate to resolve dispatch for (required)
  --base <ref>                 Base ref for scope detection (default: HEAD~1)
  --head <ref>                 Head ref; ignored unless --base is also set
  --full-label                 PR has the ${GATE_FULL_LABEL} label (forces full fan-out)
  --inline-severities <csv>    Comma-separated severities from the inline pass (escalation phase)
  --help, -h                   Show this help
Output (stdout, JSON):
  { "ok": true, "gate": "draft", "scope": { "ok": true, "filesChanged": 1, "linesChanged": 5 }, "mode": "inline", "reason": "under_threshold", "threshold": { "maxFiles": 2, "maxLines": 20 } }
  { "ok": true, "gate": "draft", "scope": { "ok": true, "filesChanged": 9, "linesChanged": 300 }, "mode": "full_fanout", "reason": "over_threshold", "threshold": { "maxFiles": 2, "maxLines": 20 } }
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
    const decision = resolveGateDispatchMode(config, opts.gate, {
      scope,
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
