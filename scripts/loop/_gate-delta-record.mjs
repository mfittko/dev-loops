/**
 * The pre-push delta decision record: local evidence at
 * `<tmp-root>/gate-delta/<reviewBaselineHead>.json`, written by
 * `check-pre-push-delta.mjs --result` (the last write for a baseline wins) and read by the
 * fixer work-order emitter and the fixed-reply guard. It never feeds a gate verdict, findings
 * ledger, comment or merge signal (PRE-PUSH-DELTA-NOT-GATE-EVIDENCE). An absent record means
 * "no delta decision". Two exceptions (PRE-PUSH-DELTA-NOT-GATE-EVIDENCE): ADR 0168 (the converged
 * marker) and ADR 0208 (the cap round's cleared delta lets the PR go ready and stands in for the clean draft_gate comment in the local pre-merge `gate_evidence` check, `buildPreMergeGateCheck`); the ADR 0208 reader
 * is `readSealedGateDeltaRecord`, which trusts only a record carrying its sha256 seal.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deltaCoverageBinding } from "@dev-loops/core/loop/pre-push-delta-review";

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

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * The ADR 0208 reader: the record for a baseline head, or null unless its bytes match the seal the
 * writer left beside it and it names that baseline. A hand edit, a missing seal or a foreign record
 * is not evidence. Throws on an unreadable record.
 */
export function readSealedGateDeltaRecord(tmpRoot, reviewBaselineHead) {
  const recordPath = gateDeltaRecordPath(tmpRoot, reviewBaselineHead);
  let text;
  let seal;
  try { text = readFileSync(recordPath, "utf8"); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  try { seal = readFileSync(`${recordPath}.seal`, "utf8").trim().toLowerCase(); } catch { return null; }
  if (seal !== sha256(text)) return null;
  const record = JSON.parse(text);
  return record?.reviewBaselineHead === reviewBaselineHead ? record : null;
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
    ...deltaCoverageBinding(decision),
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
  const text = `${JSON.stringify(record, null, 2)}\n`;
  // Delete the seal first and write it last, as writeSealed does: a crash leaves an unsealed pair, never a stale seal.
  rmSync(`${recordPath}.seal`, { force: true });
  writeFileSync(tempPath, text, "utf8");
  renameSync(tempPath, recordPath);
  writeFileSync(`${recordPath}.seal`, `${sha256(text)}\n`, "utf8");
  return recordPath;
}
