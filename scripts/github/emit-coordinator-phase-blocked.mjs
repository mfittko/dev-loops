#!/usr/bin/env node
/**
 * emit-coordinator-phase-blocked.mjs — the SANCTIONED wrapper that makes a
 * LIVE enforceRoleBudget (@dev-loops/core/loop/role-budget-bound) call for the
 * "coordinator_phase" role and, on a blocked result, writes the durable
 * "blocked" findings artifact consolidate-fanin.mjs already refuses to
 * consolidate clean — the SAME durable-blocker mechanism emit-reviewer-blocked.mjs
 * uses for the reviewer role.
 *
 * Unlike a reviewer's own <angle>.json artifact, "coordinator_phase" is a
 * SYNTHETIC identity with no legitimate same-angle reviewer — so this
 * producer writes its blocker to a RESERVED filename (BLOCKER_FILENAME,
 * below) that a reviewer's own sanitizeScopeSegment(angle)-derived filename
 * can never collide with (see the constant's own comment for the proof), and
 * refuses (fails closed) to overwrite anything already at that path that
 * isn't recognizably this producer's own prior blocker.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_USAGE, emitResult, preflightJqFilter } from "../lib/jq-output.mjs";
import { HEAD_SHA_RE } from "./record-dispatch-prompt-layout.mjs";
import { HARNESS_VALUES, enforceRoleBudget } from "@dev-loops/core/loop/role-budget-bound";

// Reserved on-disk identity for the coordinator-phase durable blocker.
// sanitizeScopeSegment (emit-fanout-dispatch.mjs) collapses every RUN of one
// or more non-alphanumeric characters to a SINGLE hyphen and trims any
// leading/trailing hyphen — so whatever string a reviewer angle name
// sanitizes to, the result can NEVER contain two adjacent hyphens ("--").
// This filename embeds "--", which makes it provably outside the image of
// sanitizeScopeSegment over every possible angle name: no configured
// reviewer angle, however named, can ever produce a per-angle artifact at
// this path. That closes both collision directions Copilot review flagged —
// a reviewer write can never clobber this blocker, and this blocker can
// never clobber a reviewer's own <angle>.json artifact.
const BLOCKER_FILENAME = "coordinator-phase--blocked.json";

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
  2  Usage/argument error, a malformed unit/consumed shape rejected by
     enforceRoleBudget itself, or the reserved blocker path already holds a
     file that is not recognizably this producer's own prior blocker
     (fail-closed collision guard — no write)`.trim();

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

export async function main(argv = process.argv.slice(2), { mkdirFn = mkdir, writeFileFn = writeFile, readFileFn = readFile } = {}) {
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

  const filePath = path.join(findingsDir, BLOCKER_FILENAME);
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

  // Fail-closed collision guard: this reserved path is disjoint from every
  // reviewer per-angle filename (see BLOCKER_FILENAME above), so the only
  // legitimate pre-existing content here is THIS producer's own prior
  // blocker for a same-head retry (mirroring emit-reviewer-blocked.mjs's
  // same-angle-overwrite behavior) — never a foreign or malformed file.
  let existingText;
  try {
    existingText = await readFileFn(filePath, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") {
      process.stderr.write(`${formatCliError(err)}\n`);
      return 2;
    }
    existingText = null;
  }
  if (existingText !== null) {
    let existing;
    try {
      existing = JSON.parse(existingText);
    } catch {
      existing = null;
    }
    const isOwnPriorBlocker = existing !== null && typeof existing === "object"
      && existing.angle === "coordinator-phase" && existing.role === "coordinator_phase"
      && existing.verdict === "blocked";
    if (!isOwnPriorBlocker) {
      process.stderr.write(`${formatCliError(new Error(`refusing to write "${filePath}": a file already exists there that is not recognizably this producer's own prior coordinator-phase blocker artifact (fail-closed collision guard) — remove it or investigate before retrying`))}\n`);
      return 2;
    }
  }

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
