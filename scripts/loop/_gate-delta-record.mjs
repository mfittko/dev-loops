/**
 * The pre-push delta decision record: local evidence at
 * `<tmp-root>/gate-delta/<reviewBaselineHead>.json`, written by
 * `check-pre-push-delta.mjs --result` (the last write for a baseline wins) and read by the
 * fixer work-order emitter and the fixed-reply guard. It never feeds a gate verdict, findings
 * ledger, comment or merge signal (PRE-PUSH-DELTA-NOT-GATE-EVIDENCE). An absent record means
 * "no delta decision".
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The next steps that authorize the committed candidate to be pushed. */
export const DELTA_CLEARING_NEXT_STEPS = Object.freeze(["push", "push_to_gate"]);

export const gateDeltaDir = (tmpRoot) => path.join(tmpRoot, "gate-delta");
export const gateDeltaRecordPath = (tmpRoot, reviewBaselineHead) => path.join(gateDeltaDir(tmpRoot), `${reviewBaselineHead}.json`);

function parseRecord(recordPath) {
  try {
    return JSON.parse(readFileSync(recordPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`pre-push delta record ${recordPath} is unreadable or not JSON: ${error.message}`);
  }
}

/** The decision record for a baseline head, or null when none was written. */
export function readGateDeltaRecord(tmpRoot, reviewBaselineHead) {
  return parseRecord(gateDeltaRecordPath(tmpRoot, reviewBaselineHead));
}

/** Every record under the tmp root. A malformed file is skipped: it carries no decision. */
export function listGateDeltaRecords(tmpRoot) {
  let names;
  try { names = readdirSync(gateDeltaDir(tmpRoot)); } catch { return []; }
  const records = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    try {
      const record = parseRecord(path.join(gateDeltaDir(tmpRoot), name));
      if (record && typeof record.reviewBaselineHead === "string") records.push(record);
    } catch { /* no decision */ }
  }
  return records;
}

/** Write the decision of one `--result` run. Returns the record path. */
export function writeGateDeltaRecord({ tmpRoot, sequence, candidateHead, invocation, decision, result }) {
  const items = Array.isArray(result?.actionableItems) ? result.actionableItems.map((item) => ({ ref: item?.ref, status: item?.status })) : [];
  const record = {
    reviewBaselineHead: sequence.reviewBaselineHead,
    candidateHead,
    actSetId: sequence.actSetId,
    invocation,
    outcome: decision.outcome,
    nextStep: decision.nextStep,
    items,
  };
  const recordPath = gateDeltaRecordPath(tmpRoot, sequence.reviewBaselineHead);
  mkdirSync(path.dirname(recordPath), { recursive: true });
  const tempPath = `${recordPath}.tmp-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(tempPath, recordPath);
  return recordPath;
}
