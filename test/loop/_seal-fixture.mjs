import fs from "node:fs";
import { createEvidenceRun, deltaEvidenceKey, sealEvidence } from "@dev-loops/core/loop/evidence-seal";

/** Records the producing run for a delta result file as written and seals its current bytes (GATE-EXEC-EVIDENCE-SEALED). */
export function sealDeltaFixture(tmpRoot, file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const { reviewBaselineHead, candidateHead, actSetId } = parsed;
  const key = deltaEvidenceKey(reviewBaselineHead, candidateHead);
  createEvidenceRun(tmpRoot, key, { reviewBaselineHead, candidateHead, actSetId });
  sealEvidence(tmpRoot, key, file, parsed);
}
