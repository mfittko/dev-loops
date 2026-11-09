/**
 * The pre-push delta decision record: local evidence at
 * `<tmp-root>/gate-delta/<reviewBaselineHead>.json`, written by
 * `check-pre-push-delta.mjs --result` (the last write for a baseline wins) and read by the
 * fixer work-order emitter and the fixed-reply guard. It never feeds a gate verdict, findings
 * ledger, comment or merge signal (PRE-PUSH-DELTA-NOT-GATE-EVIDENCE). An absent record means
 * "no delta decision". Two exceptions (PRE-PUSH-DELTA-NOT-GATE-EVIDENCE): ADR 0168 (the converged
 * marker) and ADR 0208 (the cap round's cleared delta lets the PR go ready); the ADR 0208 reader
 * is `readSealedGateDeltaRecord`, which trusts only a record carrying its sha256 seal.
 */
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deltaCoverageBinding, deltaFixerFindings } from "@dev-loops/core/loop/pre-push-delta-review";

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

/** A lifecycle refusal recorded as a finding (issue 2447): only the writer sets `lifecycle: true`; a reviewer finding cannot. */
export const isLifecycleFinding = (finding) => finding?.lifecycle === true;

/** Write the decision of one `--result` run. Returns the record path. */
export function writeGateDeltaRecord({ tmpRoot, sequence, candidateHead, invocation, decision, result, lifecycleFindings = [], refusalFindings = [], reserveOpenTasks = true }) {
  const items = Array.isArray(result?.actionableItems) ? result.actionableItems.map((item) => ({ ref: item?.ref, status: item?.status })) : [];
  // Lifecycle refusals lead. The act-list emitter's intake takes 20 entries and appends one task per open act ref, so that route leaves room for them; the thread route adds no such task.
  const open = reserveOpenTasks ? items.filter((item) => ["not_resolved", "cannot_verify"].includes(item.status)).length : 0;
  // A lifecycle finding is never dropped by the budget: refuse by name instead of sealing a record that hides open lifecycle work.
  if (lifecycleFindings.length > 0 && lifecycleFindings.length + open > 20) throw new Error(`delta_record_over_budget: ${lifecycleFindings.length} lifecycle finding(s) plus ${open} open act item(s) exceed the 20-task intake; resolve or defer some act items, then rerun the --result step`);
  const findings = [...lifecycleFindings, ...refusalFindings, ...deltaFixerFindings(result)].slice(0, Math.max(0, 20 - open));
  const record = {
    ...deltaCoverageBinding(decision),
    reviewBaselineHead: sequence.reviewBaselineHead,
    candidateHead,
    actSetId: sequence.actSetId,
    invocation,
    outcome: decision.outcome,
    nextStep: decision.nextStep,
    items,
    ...(findings.length > 0 ? { findings } : {}),
  };
  return writeSealedGateDeltaRecord(tmpRoot, sequence.reviewBaselineHead, record);
}

/**
 * Write one record and its seal for a baseline head. Returns the record path.
 * `exclusive: true` creates the record only when none exists (hard link, fails with EEXIST) and leaves an existing record and seal untouched.
 */
export function writeSealedGateDeltaRecord(tmpRoot, reviewBaselineHead, record, { exclusive = false } = {}) {
  const recordPath = gateDeltaRecordPath(tmpRoot, reviewBaselineHead);
  mkdirSync(path.dirname(recordPath), { recursive: true });
  const tempPath = `${recordPath}.tmp-${process.pid}`;
  const text = `${JSON.stringify(record, null, 2)}\n`;
  if (exclusive) {
    writeFileSync(tempPath, text, "utf8");
    try { linkSync(tempPath, recordPath); } finally { rmSync(tempPath, { force: true }); }
    // A failed seal write must not leave the linked record unsealed: remove both, then rethrow.
    try {
      rmSync(`${recordPath}.seal`, { force: true });
      writeFileSync(`${recordPath}.seal`, `${sha256(text)}\n`, "utf8");
    } catch (error) {
      // A cleanup failure must not mask the original error.
      try { rmSync(recordPath, { force: true }); rmSync(`${recordPath}.seal`, { force: true }); } catch { /* keep the original error */ }
      throw error;
    }
    return recordPath;
  }
  // Delete the seal first and write it last, as writeSealed does: a crash leaves an unsealed pair, never a stale seal.
  rmSync(`${recordPath}.seal`, { force: true });
  writeFileSync(tempPath, text, "utf8");
  renameSync(tempPath, recordPath);
  writeFileSync(`${recordPath}.seal`, `${sha256(text)}\n`, "utf8");
  return recordPath;
}
