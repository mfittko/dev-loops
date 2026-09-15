#!/usr/bin/env node
/**
 * emit-coordinator-phase-blocked.mjs — the SANCTIONED wrapper that makes a
 * LIVE enforceRoleBudget (@dev-loops/core/loop/role-budget-bound) call for the
 * "coordinator_phase" role and, on a blocked result, writes the durable
 * "blocked" findings artifact consolidate-fanin.mjs already refuses to
 * consolidate clean — the SAME durable-blocker mechanism emit-reviewer-blocked.mjs
 * uses for the reviewer role.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_USAGE, emitResult, preflightJqFilter } from "../lib/jq-output.mjs";
import { HEAD_SHA_RE } from "./record-dispatch-prompt-layout.mjs";
import { sanitizeScopeSegment } from "./emit-fanout-dispatch.mjs";
import { HARNESS_VALUES, enforceRoleBudget } from "@dev-loops/core/loop/role-budget-bound";

const USAGE = `Usage: emit-coordinator-phase-blocked.mjs --head-sha <sha> --model-turns <n> --tool-calls <n> --output-tokens <n> --findings-dir <dir> [--run <id>] [--harness <pi|claude|codex>] [--remaining-work <text>] [--help]
Live role-budget-bound enforcement for the coordinator_phase role: calls
enforceRoleBudget with the given consumption and, only when it reports
blocked, writes one "blocked" findings artifact to --findings-dir — the shape
consolidate-fanin.mjs already refuses to consolidate as clean.
Required:
  --head-sha <sha>               The FULL 40- or 64-char hex reviewed head SHA.
  --model-turns <n>              Model turns consumed this phase (non-negative integer).
  --tool-calls <n>                Tool calls consumed this phase (non-negative integer).
  --output-tokens <n>             Output tokens consumed this phase (non-negative integer).
  --findings-dir <dir>            Directory to write the blocked artifact into (created if absent).
Optional:
  --run <id>                    Round/run identifier (unit.run). Defaults to --head-sha
                                 when omitted — the round identity a coordinator always has.
  --harness <pi|claude|codex>     Dispatch harness label (unit.gateContext.harness).
  --remaining-work <text>         Free-text description of remaining phase work.
Output (stdout, JSON):
  { "ok": true, "verdict": "blocked", "reason": "...", "exceededDimensions": [...], "headSha": "...", "written": ["..."] }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Blocked artifact written
  1  Refused: the phase is within budget (nothing to emit), or --jq predicate false
  2  Usage/argument error, or a malformed unit/consumed shape rejected by
     enforceRoleBudget itself`.trim();

const parseError = buildParseError(USAGE);

function resolveFlagValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  const val = argv[idx + 1];
  if (val === undefined || val === "" || (val.length > 0 && val[0] === "-")) return "";
  return val;
}

function parseNonNegativeInt(value, flag) {
  if (!/^\d+$/.test(value)) {
    throw parseError(`${flag} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return Number(value);
}

export async function main(argv = process.argv.slice(2), { mkdirFn = mkdir, writeFileFn = writeFile } = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const headShaArg = resolveFlagValue(argv, "--head-sha");
  if (headShaArg === null || headShaArg === "" || !HEAD_SHA_RE.test(headShaArg)) {
    process.stderr.write(`${formatCliError(parseError(`--head-sha is required and must be the FULL 40- or 64-character hex head SHA${headShaArg ? ` (got ${JSON.stringify(headShaArg)})` : ""}.`))}\n`);
    return 2;
  }
  const headSha = headShaArg.toLowerCase();
  // --run is OPTIONAL: it defaults to --head-sha, the one round identity a
  // coordinator always has in hand, so the escape hatch is invokable without
  // inventing a run id.
  const runArg = resolveFlagValue(argv, "--run");
  if (runArg === "") {
    process.stderr.write(`${formatCliError(parseError("--run must be non-empty when provided."))}\n`);
    return 2;
  }
  const run = runArg === null ? headSha : runArg;
  const modelTurnsArg = resolveFlagValue(argv, "--model-turns");
  const toolCallsArg = resolveFlagValue(argv, "--tool-calls");
  const outputTokensArg = resolveFlagValue(argv, "--output-tokens");
  if (
    modelTurnsArg === null || modelTurnsArg === "" ||
    toolCallsArg === null || toolCallsArg === "" ||
    outputTokensArg === null || outputTokensArg === ""
  ) {
    process.stderr.write(`${formatCliError(parseError("--model-turns, --tool-calls, and --output-tokens are required non-negative integers."))}\n`);
    return 2;
  }
  const findingsDir = resolveFlagValue(argv, "--findings-dir");
  if (findingsDir === null || findingsDir === "") {
    process.stderr.write(`${formatCliError(parseError("--findings-dir is required and must be non-empty."))}\n`);
    return 2;
  }
  const harness = resolveFlagValue(argv, "--harness");
  if (harness === "" || (harness !== null && !HARNESS_VALUES.includes(harness))) {
    process.stderr.write(`${formatCliError(parseError(`--harness must be one of: ${HARNESS_VALUES.join(", ")}${harness ? ` (got ${JSON.stringify(harness)})` : ""}.`))}\n`);
    return 2;
  }
  const remainingWorkArg = resolveFlagValue(argv, "--remaining-work");
  if (remainingWorkArg === "") {
    process.stderr.write(`${formatCliError(parseError("--remaining-work must be non-empty when provided."))}\n`);
    return 2;
  }
  const remainingWork = remainingWorkArg === null ? undefined : remainingWorkArg;

  const jqArg = resolveFlagValue(argv, "--jq");
  if (jqArg === "") {
    process.stderr.write(`${formatCliError(parseError("Invalid --jq value: must be non-empty."))}\n`);
    return 2;
  }
  const jq = jqArg === null ? undefined : jqArg;
  const silent = argv.includes("--silent") || argv.includes("-s");
  const jqSyntaxError = preflightJqFilter(jq);
  if (jqSyntaxError !== undefined) return jqSyntaxError;
  const finish = (payload, ok) => emitResult(payload, { jq, silent, ok });

  let modelTurns;
  let toolCalls;
  let outputTokens;
  let result;
  try {
    modelTurns = parseNonNegativeInt(modelTurnsArg, "--model-turns");
    toolCalls = parseNonNegativeInt(toolCallsArg, "--tool-calls");
    outputTokens = parseNonNegativeInt(outputTokensArg, "--output-tokens");
    result = enforceRoleBudget({
      unit: { role: "coordinator_phase", run, gateContext: { headSha, ...(harness ? { harness } : {}) } },
      consumed: { modelTurns, toolCalls, outputTokens },
    });
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    return 2;
  }

  if (result.ok === true) {
    return finish({ ok: false, error: "coordinator phase is within budget — nothing to emit" }, false);
  }

  try {
    await mkdirFn(findingsDir, { recursive: true });
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    return 2;
  }

  const base = sanitizeScopeSegment("coordinator-phase") || "coordinator-phase";
  const filePath = path.join(findingsDir, `${base}.json`);
  const body = {
    angle: "coordinator-phase",
    verdict: "blocked",
    headSha: result.headSha,
    findings: [],
    role: "coordinator_phase",
    exceededDimensions: result.exceededDimensions,
    consumed: result.consumed,
    budget: result.budget,
    reason: result.reason,
    ...(remainingWork ? { remainingWork } : {}),
  };
  try {
    await writeFileFn(filePath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    return 2;
  }

  return finish({ ok: true, verdict: result.verdict, reason: result.reason, exceededDimensions: result.exceededDimensions, headSha: result.headSha, written: [filePath] }, true);
}

if (isDirectCliRun(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    process.exitCode = 2;
  }
}
