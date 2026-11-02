/**
 * Evidence seal (GATE-EXEC-EVIDENCE-SEALED): binds a review evidence file to the run that produced it.
 * A producer run writes `<tmp-root>/evidence-runs/<key>.json` with the expected identity fields;
 * the reviewer seals its file there (sha256 of the exact bytes); a consumer verifies before use.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export class EvidenceSealError extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.name = "EvidenceSealError";
    this.reason = reason;
  }
}

export const evidenceRunRecordPath = (tmpRoot, key) => path.join(tmpRoot, "evidence-runs", `${key}.json`);
/** The run key of a pre-push delta result. */
export const deltaEvidenceKey = (reviewBaselineHead, candidateHead) => `delta-${reviewBaselineHead}-${candidateHead}`;

export function createEvidenceRun(tmpRoot, key, expected) {
  const file = evidenceRunRecordPath(tmpRoot, key);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ key, expected, sealed: null })}\n`);
}

function readRun(tmpRoot, key) {
  try {
    return JSON.parse(readFileSync(evidenceRunRecordPath(tmpRoot, key), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new EvidenceSealError("evidence_run_missing", `no producing run recorded for ${key}; re-run the producer`);
    throw error;
  }
}

function assertSameRun(record, parsed, key) {
  for (const [field, value] of Object.entries(record.expected)) {
    if (parsed?.[field] !== value) throw new EvidenceSealError("evidence_foreign_run", `${field} is ${JSON.stringify(parsed?.[field])}, run ${key} expects ${JSON.stringify(value)}; re-run the producer`);
  }
}

const digestOf = (filePath) => createHash("sha256").update(readFileSync(filePath)).digest("hex");

export function sealEvidence(tmpRoot, key, filePath, parsed) {
  const record = readRun(tmpRoot, key);
  assertSameRun(record, parsed, key);
  const resolved = path.resolve(filePath);
  record.sealed = { path: resolved, sha256: digestOf(resolved) };
  writeFileSync(evidenceRunRecordPath(tmpRoot, key), `${JSON.stringify(record)}\n`);
  return record.sealed;
}

export function verifyEvidence(tmpRoot, key, filePath, parsed) {
  const record = readRun(tmpRoot, key);
  assertSameRun(record, parsed, key);
  if (!record.sealed) throw new EvidenceSealError("evidence_unsealed", `${filePath} was never sealed for ${key}; seal it with seal-evidence.mjs or re-run the producer`);
  if (record.sealed.path !== path.resolve(filePath) || record.sealed.sha256 !== digestOf(filePath)) {
    throw new EvidenceSealError("evidence_digest_mismatch", `${filePath} differs from the sealed bytes of ${key}; re-run the producer, never repair by hand`);
  }
}
