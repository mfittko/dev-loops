/**
 * Evidence seal (GATE-EXEC-EVIDENCE-SEALED): binds a review evidence file to the run that produced it.
 * A producer run mints a run id and writes `<tmp-root>/evidence-runs/<key>.json` with the expected identity fields;
 * the reviewer seals its file there (sha256 of the exact bytes); a consumer verifies before use.
 * Each producer run owns its own record, so a re-run at the same heads opens a new unsealed record and the old seal stays final.
 * Re-creating a run with an existing key leaves its record, and any seal, unchanged.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
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

// A concurrent reader sees the old or the new file, never a truncated one.
function writeAtomic(file, content) {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, file);
}

/** Opens a run record. The key derives from `expected`. `resultPath` is the briefed result path; sealing any other path is refused. */
export function createEvidenceRun(tmpRoot, expected, resultPath) {
  const key = deltaResultKey(expected);
  const file = evidenceRunRecordPath(tmpRoot, key);
  // The pointer path validates the identity before anything is written.
  const pointer = currentRunPointerPath(tmpRoot, expected);
  mkdirSync(path.dirname(file), { recursive: true });
  // The briefed directory exists before it is resolved, so a symlinked prefix is always realpathed.
  mkdirSync(path.dirname(path.resolve(resultPath)), { recursive: true });
  // An existing record is never overwritten, so a sealed record stays intact.
  if (!existsSync(file)) writeAtomic(file, `${JSON.stringify({ key, expected, resultPath: canonicalPath(resultPath), sealed: null })}\n`);
  // The newest run of a head pair is the current one; a superseded run's sealed result stops verifying.
  writeAtomic(pointer, `${expected.runId}\n`);
}

// One pointer per head pair. An identity without both canonical heads and a run id is `evidence_malformed`.
function currentRunPointerPath(tmpRoot, expected) {
  const { reviewBaselineHead, candidateHead, runId } = expected ?? {};
  deltaEvidenceKey(reviewBaselineHead, candidateHead, runId);
  return path.join(tmpRoot, "evidence-runs", `current-delta-${reviewBaselineHead}-${candidateHead}.txt`);
}

function readRun(tmpRoot, key) {
  try {
    return JSON.parse(readFileSync(evidenceRunRecordPath(tmpRoot, key), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new EvidenceSealError("evidence_run_missing", `no producing run recorded for ${key}; re-run the producer`);
    if (error instanceof SyntaxError) throw new EvidenceSealError("evidence_malformed", `run record ${key} is not valid JSON; re-run the producer, never repair by hand`);
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

/** `bytes` is required and holds the exact bytes `parsed` came from, so the seal covers what was parsed. */
export function sealEvidence(tmpRoot, filePath, parsed, bytes) {
  const key = deltaResultKey(parsed);
  const record = readRun(tmpRoot, key);
  assertSameRun(record, parsed, key);
  if (record.sealed) throw new EvidenceSealError("evidence_foreign_run", `run ${key} is already sealed and a seal is final; re-run the producer for a new run`);
  const resolved = canonicalPath(filePath);
  if (record.resultPath !== resolved) throw new EvidenceSealError("evidence_foreign_run", `${filePath} is not the result path briefed for ${key} (${record.resultPath}); re-run the producer`);
  record.sealed = { path: resolved, sha256: sha256Of(bytes) };
  // Exclusive create makes the seal one-time: of two racing sealers only one wins the claim.
  try { writeFileSync(`${evidenceRunRecordPath(tmpRoot, key)}.sealed`, "", { flag: "wx" }); } catch (error) {
    if (error?.code === "EEXIST") throw new EvidenceSealError("evidence_foreign_run", `run ${key} is already sealed and a seal is final; re-run the producer for a new run`);
    throw error;
  }
  writeAtomic(evidenceRunRecordPath(tmpRoot, key), `${JSON.stringify(record)}\n`);
  return record.sealed;
}

/** Verifies `filePath` against its sealed record. `sha256` is the digest of the exact bytes the consumer parsed, so the check covers the bytes that drive the decision. */
export function verifyEvidence(tmpRoot, filePath, parsed, sha256) {
  if (typeof sha256 !== "string") throw new TypeError("verifyEvidence requires the sha256 of the bytes the caller parsed");
  const key = deltaResultKey(parsed);
  // The pointer of the parsed heads comes first, so a foreign result with rewritten heads names the current run, not a missing record.
  const pointer = currentRunPointerPath(tmpRoot, parsed);
  if (!existsSync(pointer)) throw new EvidenceSealError("evidence_run_missing", `no current run recorded for these heads (${key}); re-run the producer`);
  const current = readFileSync(pointer, "utf8").trim();
  if (current !== parsed.runId) throw new EvidenceSealError("evidence_foreign_run", `run ${parsed.runId} is not the current run ${current} for these heads; re-run the producer or use the current run's result`);
  const record = readRun(tmpRoot, key);
  assertSameRun(record, parsed, key);
  if (!record.sealed) throw new EvidenceSealError("evidence_unsealed", `${filePath} was never sealed for ${key}; seal it with seal-evidence.mjs or re-run the producer`);
  if (record.sealed.path !== canonicalPath(filePath)) throw new EvidenceSealError("evidence_foreign_run", `${filePath} is not the file sealed for ${key} (${record.sealed.path}); re-run the producer`);
  if (record.sealed.sha256 !== sha256) {
    throw new EvidenceSealError("evidence_digest_mismatch", `${filePath} differs from the sealed bytes of ${key}; re-run the producer, never repair by hand`);
  }
}
