#!/usr/bin/env node
/**
 * wait-for-gate-units.mjs — the Claude Code join for a gate round's dispatched
 * units (GATE-EXEC-HARNESS-JOIN). One foreground, read-only process: it
 * re-checks every pending unit every 2 s until all are done, the round is
 * retired, or the timeout is reached. It writes no file, spawns no process and
 * makes no network call.
 *
 * The count unit is the dispatch unit (one entry of the emit plan's `units`).
 * A review unit is done when its pull receipt verifies and every covered angle
 * has a post-pull result (the verification consolidate-fanin.mjs applies). The
 * judge unit is done when its verdict result verifies with role `judge`.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { verifyPullReceipt, verifyPulledResult } from "../github/_work-order-protocol.mjs";
import { CHECKPOINT_SENTINEL_PREFIX } from "../github/verify-fresh-review-context.mjs";
import { findRetirementAfter } from "@dev-loops/core/loop/gate-round-retirement";
import { resolveGateArtifactTmpRoot } from "./_repo-root-resolver.mjs";

export const DEFAULT_TIMEOUT_MS = 540000;
export const MAX_TIMEOUT_MS = 570000;
export const RECHECK_INTERVAL_MS = 2000;
const EXIT = { all_done: 0, timeout: 2, round_retired: 3 };

const USAGE = `Usage: wait-for-gate-units.mjs (--emit-plan <path> [--unit <scope>]... | --judge-plan <path>) --tmp-root <worktree>/tmp [--timeout-ms <n>]
Block in one foreground process until the round's dispatched units are done.
Outcomes (JSON on stdout): all_done (exit 0), timeout (exit 2), round_retired (exit 3). Invalid input: ok false, exit 1.
  --emit-plan <path>   the round's <gate>-<headSha>.emit-plan.json; waits on every unit unless --unit narrows it
  --unit <scope>       repeatable; restrict the wait to these unit scopes
  --judge-plan <path>  the round's judge-emit-plan.json; waits on the one judge unit
  --tmp-root <dir>     worktree-local tmp root with the sentinels and retirement records
  --timeout-ms <n>     1 to ${MAX_TIMEOUT_MS} (default ${DEFAULT_TIMEOUT_MS})`;

export function parseWaitArgs(argv) {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      "emit-plan": { type: "string" },
      unit: { type: "string", multiple: true },
      "judge-plan": { type: "string" },
      "tmp-root": { type: "string" },
      "timeout-ms": { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) return { help: true };
  if ((values["emit-plan"] === undefined) === (values["judge-plan"] === undefined)) throw new Error("pass exactly one of --emit-plan and --judge-plan");
  if (values["judge-plan"] !== undefined && values.unit !== undefined) throw new Error("--unit applies only to --emit-plan");
  if (!values["tmp-root"]) throw new Error("--tmp-root is required");
  const timeoutText = values["timeout-ms"] ?? String(DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number(timeoutText);
  if (!/^\d+$/u.test(timeoutText) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new Error(`--timeout-ms must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  return { emitPlan: values["emit-plan"], judgePlan: values["judge-plan"], units: values.unit, tmpRoot: values["tmp-root"], timeoutMs, jq: values.jq, silent: values.silent };
}

async function readPlan(planPath) {
  let plan;
  try { plan = JSON.parse(await readFile(planPath, "utf8")); } catch (error) { throw new Error(`plan ${planPath} is unreadable or malformed: ${error.message}`); }
  if (plan === null || typeof plan !== "object") throw new Error(`plan ${planPath} is not a JSON object`);
  return plan;
}

/** Normalize a plan into { gate, headSha, role, units: [{ scope, angles, outputRefs, receipt query }] }. */
function selectUnits({ plan, judge, wanted }) {
  const compact = (unit) => ({ workOrderRef: unit.workOrderRef, workOrderDigest: unit.workOrderDigest, executionIdentity: unit.executionIdentity });
  if (judge) {
    const { gate, headSha } = plan.workOrder?.roundIdentity ?? {};
    const [verdictPath] = plan.workOrder?.outputRefs ?? [];
    if (typeof plan.workOrderRef !== "string" || typeof verdictPath !== "string") throw new Error("judge plan carries no compact work-order reference or verdict outputRef");
    return { gate, headSha, role: "judge", units: [{ scope: "judge", angles: ["judge"], outputRefs: [verdictPath], ...compact(plan) }] };
  }
  if (!Array.isArray(plan.units)) throw new Error("emit plan has no units array");
  const units = plan.units.map((unit) => {
    if (typeof unit?.workOrderRef !== "string") throw new Error(`emit-plan unit ${JSON.stringify(unit?.scope)} carries no compact work-order reference`);
    const angles = Array.isArray(unit.angles) ? unit.angles : [];
    const outputRefs = unit.workOrder?.outputRefs ?? unit.outputRefs;
    if (!Array.isArray(outputRefs) || outputRefs.length !== angles.length) throw new Error(`emit-plan unit ${unit.scope} names no result path for each covered angle`);
    return { scope: unit.scope, angles, outputRefs, ...compact(unit) };
  });
  const unknown = (wanted ?? []).filter((scope) => !units.some((unit) => unit.scope === scope));
  if (unknown.length > 0) throw new Error(`unknown --unit scope(s): ${unknown.join(", ")}`);
  return { gate: plan.gate, headSha: plan.headSha, role: "review", units: wanted === undefined ? units : units.filter((unit) => wanted.includes(unit.scope)) };
}

const exists = (file) => stat(file).then(() => true, () => false);

async function checkUnit(unit, { role, receiptTmpRoot, tmpRoot, headSha }) {
  const query = { receiptTmpRoot, role, workOrderRef: unit.workOrderRef, workOrderDigest: unit.workOrderDigest, executionIdentity: unit.executionIdentity };
  const receipt = await verifyPullReceipt(query);
  const results = await Promise.all(unit.outputRefs.map((resultPath) => verifyPulledResult({ resultPath, ...query })));
  const missingAngles = unit.angles.filter((_, index) => !results[index].ok);
  if (receipt.ok && missingAngles.length === 0) return null;
  const pulledCount = unit.angles.length - missingAngles.length;
  const started = receipt.reason !== "receipt_missing" || await exists(path.join(tmpRoot, `${CHECKPOINT_SENTINEL_PREFIX}${unit.scope}-${headSha}.json`));
  const state = pulledCount > 0 ? "partial" : started ? "running" : "not_started";
  return { scope: unit.scope, executionIdentity: unit.executionIdentity, state, missingAngles };
}

export async function waitForUnits({ emitPlan, judgePlan, units: wanted, tmpRoot, timeoutMs = DEFAULT_TIMEOUT_MS, receiptTmpRoot, now = Date.now, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const planPath = emitPlan ?? judgePlan;
  const planStat = await stat(planPath).catch(() => { throw new Error(`plan ${planPath} does not exist`); });
  const { gate, headSha, role, units } = selectUnits({ plan: await readPlan(planPath), judge: judgePlan !== undefined, wanted });
  const receipts = receiptTmpRoot ?? resolveGateArtifactTmpRoot(path.dirname(path.resolve(tmpRoot)));
  const started = now();
  for (;;) {
    const result = (outcome, missing = [], done = []) => ({ ok: true, outcome, gate, headSha, unitCount: units.length, done, missing, elapsedMs: now() - started });
    if (!await exists(planPath) || findRetirementAfter(tmpRoot, gate, headSha, planStat.mtimeMs) !== null) return result("round_retired");
    const checks = await Promise.all(units.map((unit) => checkUnit(unit, { role, receiptTmpRoot: receipts, tmpRoot, headSha })));
    const missing = checks.filter(Boolean);
    const done = units.filter((_, index) => checks[index] === null).map((unit) => unit.scope);
    if (missing.length === 0) return result("all_done", [], done);
    const remaining = timeoutMs - (now() - started);
    if (remaining <= 0) return result("timeout", missing, done);
    await delay(Math.min(RECHECK_INTERVAL_MS, remaining));
  }
}

export async function main(argv = process.argv.slice(2)) {
  let result;
  let options;
  try {
    options = parseWaitArgs(argv);
    if (options.help) { process.stdout.write(`${USAGE}\n${JQ_OUTPUT_USAGE}\n`); return; }
    result = await waitForUnits(options);
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const emitted = emitResult(result, { jq: options?.jq, silent: options?.silent, ok: true });
  process.exitCode = emitted === 2 ? 2 : result.ok ? EXIT[result.outcome] : 1;
}

if (isDirectCliRun(import.meta.url)) await main();
