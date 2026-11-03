import { createHash } from "node:crypto";
import fs from "node:fs";
import { EvidenceSealError, createEvidenceRun, deltaEvidenceKey, mintEvidenceRunId, sealEvidence, verifyEvidence } from "@dev-loops/core/loop/evidence-seal";

/**
 * Models a fresh producer run for a delta result file: opens a new run record with its own run id, writes that id into the file and seals the current bytes (GATE-EXEC-EVIDENCE-SEALED).
 * A file that already verifies as sealed stays byte-identical, so repeated emissions over one fixture see one source.
 */
export function sealDeltaFixture(tmpRoot, file) {
  const bytes = fs.readFileSync(file);
  const current = JSON.parse(bytes.toString("utf8"));
  if (current.runId) {
    const key = deltaEvidenceKey(current.reviewBaselineHead, current.candidateHead, current.runId);
    try {
      verifyEvidence(tmpRoot, key, file, current, createHash("sha256").update(bytes).digest("hex"));
      return;
    } catch (error) {
      if (!(error instanceof EvidenceSealError)) throw error;
      if (error.reason === "evidence_run_missing") { // another tmp root over the same bytes: record this run there, leave the bytes alone
        createEvidenceRun(tmpRoot, key, { reviewBaselineHead: current.reviewBaselineHead, candidateHead: current.candidateHead, actSetId: current.actSetId, runId: current.runId }, file);
        sealEvidence(tmpRoot, key, file, current, bytes);
        return;
      }
    }
  }
  const parsed = { ...current, runId: mintEvidenceRunId() };
  const { reviewBaselineHead, candidateHead, actSetId, runId } = parsed;
  const key = deltaEvidenceKey(reviewBaselineHead, candidateHead, runId);
  const written = JSON.stringify(parsed);
  fs.writeFileSync(file, written);
  createEvidenceRun(tmpRoot, key, { reviewBaselineHead, candidateHead, actSetId, runId }, file);
  sealEvidence(tmpRoot, key, file, parsed, Buffer.from(written));
}
