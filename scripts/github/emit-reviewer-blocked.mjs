#!/usr/bin/env node
/**
 * emit-reviewer-blocked.mjs — the SANCTIONED wrapper that makes a LIVE
 * enforceReviewerUnitBound (@dev-loops/core/loop/reviewer-unit-bound) call and,
 * on a blocked result, writes the durable per-angle "blocked" artifact(s) a
 * scoped reviewer unit's own escape hatch produces (see
 * emit-fanout-dispatch.mjs's buildAngleNamingSuffix "Bounded reviewer
 * contract"). consolidate-fanin.mjs already fails the whole fan-in closed on
 * any "blocked" per-angle artifact — this is the only sanctioned producer of
 * one.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_USAGE, emitResult, preflightJqFilter } from "../lib/jq-output.mjs";
import { HEAD_SHA_RE } from "./record-dispatch-prompt-layout.mjs";
import { sanitizeScopeSegment } from "./emit-fanout-dispatch.mjs";
import { HARNESS_VALUES, enforceReviewerUnitBound } from "@dev-loops/core/loop/reviewer-unit-bound";

const USAGE = `Usage: emit-reviewer-blocked.mjs --head-sha <sha> --angles <csv> --model-turns <n> --tool-calls <n> --findings-dir <dir> [--run <id>] [--completed-angles <csv>] [--harness <pi|claude|codex>] [--help]
Live reviewer-unit-bound enforcement: calls enforceReviewerUnitBound with the
given consumption/coverage and, only when it reports blocked, writes one
"blocked" per-angle findings artifact per unreviewed angle to --findings-dir —
the shape consolidate-fanin.mjs already refuses to consolidate as clean.
Required:
  --head-sha <sha>               The FULL 40- or 64-char hex reviewed head SHA.
  --angles <csv>                 Comma-separated assigned angle names (unit.angles).
  --model-turns <n>              Model turns consumed this unit (non-negative integer).
  --tool-calls <n>                Tool calls consumed this unit (non-negative integer).
  --findings-dir <dir>            Directory to write blocked artifact(s) into (created if absent).
Optional:
  --run <id>                    Round/run identifier (unit.run). Defaults to --head-sha
                                 when omitted — the round identity a reviewer always has.
  --completed-angles <csv>        Comma-separated angles actually covered before budget ran out.
  --harness <pi|claude|codex>     Dispatch harness label (unit.gateContext.harness).
Output (stdout, JSON):
  { "ok": true, "verdict": "blocked", "reason": "...", "unreviewedAngles": [...], "headSha": "...", "written": ["..."] }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Blocked artifact(s) written
  1  Refused: the unit is within budget and fully covered (nothing to emit —
     write normal per-angle artifacts instead), or --jq predicate false
  2  Usage/argument error, or a malformed unit/consumed shape rejected by
     enforceReviewerUnitBound itself`.trim();

const parseError = buildParseError(USAGE);

function resolveFlagValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  const val = argv[idx + 1];
  if (val === undefined || val === "" || (val.length > 0 && val[0] === "-")) return "";
  return val;
}

function parseCsv(value) {
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
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
  // reviewer always has in hand, so the escape hatch is invokable without
  // inventing a run id.
  const runArg = resolveFlagValue(argv, "--run");
  if (runArg === "") {
    process.stderr.write(`${formatCliError(parseError("--run must be non-empty when provided."))}\n`);
    return 2;
  }
  const run = runArg === null ? headSha : runArg;
  const anglesArg = resolveFlagValue(argv, "--angles");
  if (anglesArg === null || anglesArg === "") {
    process.stderr.write(`${formatCliError(parseError("--angles is required and must be a non-empty comma-separated list."))}\n`);
    return 2;
  }
  const angles = parseCsv(anglesArg);
  const completedAnglesArg = resolveFlagValue(argv, "--completed-angles");
  const completedAngles = completedAnglesArg === null ? undefined : parseCsv(completedAnglesArg);
  const modelTurnsArg = resolveFlagValue(argv, "--model-turns");
  const toolCallsArg = resolveFlagValue(argv, "--tool-calls");
  if (modelTurnsArg === null || modelTurnsArg === "" || toolCallsArg === null || toolCallsArg === "") {
    process.stderr.write(`${formatCliError(parseError("--model-turns and --tool-calls are required non-negative integers."))}\n`);
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
  let result;
  try {
    modelTurns = parseNonNegativeInt(modelTurnsArg, "--model-turns");
    toolCalls = parseNonNegativeInt(toolCallsArg, "--tool-calls");
    result = enforceReviewerUnitBound({
      unit: { run, gateContext: { headSha, ...(harness ? { harness } : {}) }, angles },
      consumed: { modelTurns, toolCalls },
      completedAngles,
    });
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    return 2;
  }

  if (result.ok === true) {
    return finish({ ok: false, error: "unit is within budget and fully covered — write normal per-angle artifacts, not a blocked result" }, false);
  }

  // An over-budget run whose reported coverage is nominally complete is still
  // untrustworthy per the primitive (budget exhaustion always blocks) — mark
  // every assigned angle blocked in that case, not just the (empty) unreviewed
  // list.
  const anglesToBlock = result.unreviewedAngles.length > 0 ? result.unreviewedAngles : result.unit.angles;

  try {
    await mkdirFn(findingsDir, { recursive: true });
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    return 2;
  }

  const written = [];
  for (const angle of anglesToBlock) {
    const base = sanitizeScopeSegment(angle) || "angle";
    // ponytail: content-hash suffix (first 8 hex chars of sha256(angle))
    // guarantees cross-unit uniqueness. sanitizeScopeSegment is lossy (e.g.
    // "a/b" and "a-b" both sanitize to "a-b"), and every reviewer unit in a
    // grouped round shares ONE --findings-dir, so a sanitized-only filename
    // can let a later unit's blocked emission clobber an earlier unit's —
    // silently losing a blocked angle from fan-in. Keying on the angle's
    // exact string instead of a per-invocation bump counter makes distinct
    // angles land in distinct files even across separate invocations, and
    // re-emitting the SAME angle stays idempotent (overwrites only its own
    // artifact).
    const filename = `${base}-${createHash("sha256").update(angle, "utf8").digest("hex").slice(0, 8)}.json`;
    const filePath = path.join(findingsDir, filename);
    const body = {
      angle,
      verdict: "blocked",
      headSha: result.headSha,
      findings: [],
      unreviewedAngles: result.unreviewedAngles,
      reason: result.reason,
    };
    try {
      await writeFileFn(filePath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    } catch (err) {
      process.stderr.write(`${formatCliError(err)}\n`);
      return 2;
    }
    written.push(filePath);
  }

  return finish({ ok: true, verdict: result.verdict, reason: result.reason, unreviewedAngles: result.unreviewedAngles, headSha: result.headSha, written }, true);
}

if (isDirectCliRun(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    process.exitCode = 2;
  }
}
