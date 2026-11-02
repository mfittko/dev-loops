/**
 * Evidence seal (GATE-EXEC-EVIDENCE-SEALED): binds a review evidence file to the run that produced it.
 * A producer run mints a run id and writes `<tmp-root>/evidence-runs/<key>.json` with the expected identity fields;
 * the reviewer seals its file there (sha256 of the exact bytes); a consumer verifies before use.
 * Each producer run owns its own record, so a re-run at the same heads opens a new unsealed record and the old seal stays final.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

export class EvidenceSealError extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.name = "EvidenceSealError";
    this.reason = reason;
  }
}

const FULL_HEAD_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RUN_ID = /^[0-9a-f]{16}$/;

export const evidenceRunRecordPath = (tmpRoot, key) => path.join(tmpRoot, "evidence-runs", `${key}.json`);
/** A fresh per-run identity, minted by the producer run. */
export const mintEvidenceRunId = () => randomBytes(8).toString("hex");
/** The run key of a pre-push delta result. Both heads must be canonical full lowercase SHAs and the run id a minted id, so the key never leaves `evidence-runs/`. */
export function deltaEvidenceKey(reviewBaselineHead, candidateHead, runId) {
  for (const [field, value, pattern] of [["reviewBaselineHead", reviewBaselineHead, FULL_HEAD_SHA], ["candidateHead", candidateHead, FULL_HEAD_SHA], ["runId", runId, RUN_ID]]) {
    if (typeof value !== "string" || !pattern.test(value)) throw new EvidenceSealError("evidence_malformed", `${field} ${JSON.stringify(value)} is not a canonical ${field === "runId" ? "run id (16 lowercase hex characters)" : "full lowercase commit SHA"}; re-run the producer`);
  }
  return `delta-${reviewBaselineHead}-${candidateHead}-${runId}`;
}

/** The run key of a parsed delta result. A non-object result (null, array, primitive) is `evidence_malformed`, like a bad head or run id. */
export function deltaResultKey(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new EvidenceSealError("evidence_malformed", `a delta result must be a JSON object, got ${JSON.stringify(result)}; re-run the producer`);
  return deltaEvidenceKey(result.reviewBaselineHead, result.candidateHead, result.runId);
}

// The real path of a file, or of its directory plus name when the file is not written yet (the directory must exist).
function canonicalPath(filePath) {
  const resolved = path.resolve(filePath);
  try { return realpathSync(resolved); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return path.join(realpathSync(path.dirname(resolved)), path.basename(resolved));
  }
}

/** Opens a run record. `resultPath`, when given, is the briefed result path; sealing any other path is refused. */
export function createEvidenceRun(tmpRoot, key, expected, resultPath) {
  const file = evidenceRunRecordPath(tmpRoot, key);
  // An existing record stays intact: a seal is final.
  if (existsSync(file)) return;
  mkdirSync(path.dirname(file), { recursive: true });
  // The briefed directory exists before it is resolved, so a symlinked prefix is always realpathed.
  if (resultPath) mkdirSync(path.dirname(path.resolve(resultPath)), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ key, expected, ...(resultPath ? { resultPath: canonicalPath(resultPath) } : {}), sealed: null })}\n`);
  // The newest run of a head pair is the current one; a superseded run's sealed result stops verifying.
  const pointer = currentRunPointerPath(tmpRoot, expected);
  if (pointer) writeFileSync(pointer, `${expected.runId}\n`);
}

// One pointer per head pair, only for records whose identity carries both heads and a run id.
function currentRunPointerPath(tmpRoot, expected) {
  const { reviewBaselineHead, candidateHead, runId } = expected ?? {};
  if (!FULL_HEAD_SHA.test(reviewBaselineHead ?? "") || !FULL_HEAD_SHA.test(candidateHead ?? "") || !RUN_ID.test(runId ?? "")) return null;
  return path.join(tmpRoot, "evidence-runs", `current-delta-${reviewBaselineHead}-${candidateHead}.txt`);
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
  if (!record?.expected || typeof record.expected !== "object") throw new EvidenceSealError("evidence_run_missing", `run record ${key} holds no expected identity; re-run the producer`);
  for (const [field, value] of Object.entries(record.expected)) {
    if (parsed?.[field] !== value) throw new EvidenceSealError("evidence_foreign_run", `${field} is ${JSON.stringify(parsed?.[field])}, run ${key} expects ${JSON.stringify(value)}; re-run the producer`);
  }
}

const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function sealEvidence(tmpRoot, key, filePath, parsed) {
  const record = readRun(tmpRoot, key);
  assertSameRun(record, parsed, key);
  if (record.sealed) throw new EvidenceSealError("evidence_foreign_run", `run ${key} is already sealed and a seal is final; re-run the producer for a new run`);
  const resolved = canonicalPath(filePath);
  if (record.resultPath && record.resultPath !== resolved) throw new EvidenceSealError("evidence_foreign_run", `${filePath} is not the result path briefed for ${key} (${record.resultPath}); re-run the producer`);
  record.sealed = { path: resolved, sha256: sha256Of(readFileSync(resolved)) };
  writeFileSync(evidenceRunRecordPath(tmpRoot, key), `${JSON.stringify(record)}\n`);
  return record.sealed;
}

/** Verifies `filePath` against its sealed record. `sha256` is the digest of the exact bytes the consumer parsed, so the check covers the bytes that drive the decision. */
export function verifyEvidence(tmpRoot, key, filePath, parsed, sha256) {
  if (typeof sha256 !== "string") throw new TypeError("verifyEvidence requires the sha256 of the bytes the caller parsed");
  const record = readRun(tmpRoot, key);
  assertSameRun(record, parsed, key);
  const pointer = currentRunPointerPath(tmpRoot, record.expected);
  // ponytail: a record without a pointer predates it and stays verifiable.
  if (pointer && existsSync(pointer)) {
    const current = readFileSync(pointer, "utf8").trim();
    if (current !== record.expected.runId) throw new EvidenceSealError("evidence_foreign_run", `run ${record.expected.runId} is superseded by run ${current} for these heads; re-run the producer or use the current run's result`);
  }
  if (!record.sealed) throw new EvidenceSealError("evidence_unsealed", `${filePath} was never sealed for ${key}; seal it with seal-evidence.mjs or re-run the producer`);
  if (record.sealed.path !== canonicalPath(filePath)) throw new EvidenceSealError("evidence_foreign_run", `${filePath} is not the file sealed for ${key} (${record.sealed.path}); re-run the producer`);
  if (record.sealed.sha256 !== sha256) {
    throw new EvidenceSealError("evidence_digest_mismatch", `${filePath} differs from the sealed bytes of ${key}; re-run the producer, never repair by hand`);
  }
}
