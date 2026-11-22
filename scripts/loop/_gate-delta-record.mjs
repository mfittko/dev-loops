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
  const record = readSealedFile(gateDeltaRecordPath(tmpRoot, reviewBaselineHead));
  return record?.reviewBaselineHead === reviewBaselineHead ? record : null;
}

// The parsed record at `recordPath` when its bytes match the seal beside it, else null. Throws on an unreadable record.
function readSealedFile(recordPath) {
  let text;
  let seal;
  try { text = readFileSync(recordPath, "utf8"); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  try { seal = readFileSync(`${recordPath}.seal`, "utf8").trim().toLowerCase(); } catch { return null; }
  return seal === sha256(text) ? JSON.parse(text) : null;
}

export const gateCoverDir = (tmpRoot) => path.join(tmpRoot, "gate-cover");
/** The cover record of one cap-round act ref (ADR 0255 amendment): keyed by the cap-round head and the ref, never by a baseline, so it takes no baseline record slot. */
export const gateCoverRecordPath = (tmpRoot, capHead, ref) => path.join(gateCoverDir(tmpRoot), `${capHead}-${sha256(String(ref)).slice(0, 24)}.json`);

/** The sealed cover record of `ref` at `capHead`, or null unless its bytes match its seal and it names that cap head and ref. A hand edit or a foreign record is not evidence. Throws on an unreadable record. */
export function readSealedCoverRecord(tmpRoot, capHead, ref) {
  const record = readSealedFile(gateCoverRecordPath(tmpRoot, capHead, ref));
  return record?.capHead === capHead && record.ref === ref ? record : null;
}

/** A cover record that counts toward coverage: a locally_clear run that resolved the ref. */
export const isClearingCoverRecord = (record) => record?.outcome === "locally_clear" && record.status === "resolved" && DELTA_CLEARING_NEXT_STEPS.includes(record.nextStep);

/**
 * Write the cover record of one act ref. A sealed clearing cover record is never replaced (the call throws), so a later run cannot overwrite the evidence coverage counts.
 * A non-clearing or unsealed leftover is replaced: the caller continues its invocation count.
 */
export function writeCoverRecord(tmpRoot, record) {
  if (isClearingCoverRecord(readSealedCoverRecord(tmpRoot, record.capHead, record.ref))) throw new Error(`the cover record for act ref ${record.ref} at ${record.capHead} is sealed locally_clear and is never overwritten`);
  return writeSealedFile(gateCoverRecordPath(tmpRoot, record.capHead, record.ref), record, {});
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
export function writeGateDeltaRecord({ tmpRoot, sequence, candidateHead, invocation, decision, result, lifecycleFindings = [], bodySha256, bodyTarget }) {
  const items = Array.isArray(result?.actionableItems) ? result.actionableItems.map((item) => ({ ref: item?.ref, status: item?.status })) : [];
  // The 20-entry cap bounds the record findings, lifecycle findings first; the emitter's act-ref tasks are not counted against it.
  const findings = [...lifecycleFindings, ...deltaFixerFindings(result)].slice(0, 20);
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
    ...(typeof bodySha256 === "string" ? { bodySha256, bodyTarget } : {}),
  };
  return writeSealedGateDeltaRecord(tmpRoot, sequence.reviewBaselineHead, record);
}

/**
 * Write one record and its seal for a baseline head. Returns the record path.
 * `exclusive: true` creates the record only when none exists (hard link, fails with EEXIST) and leaves an existing record and seal untouched.
 */
export function writeSealedGateDeltaRecord(tmpRoot, reviewBaselineHead, record, options = {}) {
  return writeSealedFile(gateDeltaRecordPath(tmpRoot, reviewBaselineHead), record, options);
}

function writeSealedFile(recordPath, record, { exclusive = false }) {
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
