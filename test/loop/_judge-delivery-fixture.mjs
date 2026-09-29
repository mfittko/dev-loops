// Judge pull-transport fixture (ADR 0106): seed the round's authoritative
// sources, emit the judge work order through the real producer, and pull it
// through the shared reader so a pull receipt exists.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { computeContentDigest, computeSpecDigest, specCriterionIds } from "@dev-loops/core/loop/spec-authority";
import { pullWorkOrder } from "../../scripts/github/_work-order-protocol.mjs";
import { buildGateContextPath } from "../../scripts/github/_gate-artifact-paths.mjs";
import { emitJudgeWorkOrder } from "../../scripts/loop/emit-judge-work-order.mjs";

export const JUDGE_SPEC = { acceptanceCriteria: ["Fix the finding"], definitionOfDone: ["Verdicts are valid"], nonGoals: ["No new schema"] };

/**
 * Write the sources the producer reads under `root` and return the producer
 * arguments. `findingsFile`/`specFile` default to fixture files; an existing
 * spec file is reused as-is. `.devloops` keeps root resolution hermetic.
 */
export async function seedJudgeSources(root, { repo = "o/r", pr = 7, gate = "pre_approval_gate", headSha, findingsFile, specFile, contentDigest = computeContentDigest("reviewed-impl") }) {
  if (!["", ".yaml", ".yml", ".json"].some((ext) => existsSync(path.join(root, `.devloops${ext}`)))) await writeFile(path.join(root, ".devloops"), "version: 1\n", "utf8");
  if (!findingsFile) {
    findingsFile = "judge-fixture/ledger.json";
    await mkdir(path.join(root, "judge-fixture"), { recursive: true });
    await writeFile(path.join(root, findingsFile), JSON.stringify({ overallVerdict: "findings_present", findings: [{ severity: "high", summary: "a defect" }] }));
  }
  let spec = await readFile(path.resolve(root, specFile ?? "-"), "utf8").then(JSON.parse, () => null);
  if (!spec) {
    spec = JUDGE_SPEC;
    specFile = "judge-fixture/spec.json";
    await mkdir(path.join(root, "judge-fixture"), { recursive: true });
    await writeFile(path.join(root, specFile), JSON.stringify(spec));
  }
  const identityFile = "judge-fixture/identity.json";
  await mkdir(path.join(root, "judge-fixture"), { recursive: true });
  await writeFile(path.join(root, identityFile), JSON.stringify({ specDigest: computeSpecDigest(spec), headSha, contentDigest, checkedCriteria: specCriterionIds(spec) }));
  const evidence = "## PR body\nDeclared scope: fix the finding.\n";
  await writeFile(path.join(root, "judge-fixture", "evidence.md"), evidence);
  const contextPath = path.join(root, buildGateContextPath({ repo, pr, gate, headSha }));
  await mkdir(path.dirname(contextPath), { recursive: true });
  await writeFile(contextPath, JSON.stringify({ requiredReads: [{ kind: "evidence", path: "judge-fixture/evidence.md", sha256: createHash("sha256").update(evidence).digest("hex"), bytes: evidence.length, required: true }] }));
  return { repo, pr, gate, headSha, findingsFile, specFile, identityFile, cwd: root };
}

/**
 * Write a verdict the way a judge does after its pull. The explicit mtime keeps the
 * post-pull ordering deterministic where file mtimes trail Date.now() (Linux).
 */
export async function writeVerdictAfterPull(filePath, bytes) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
  const later = new Date(Date.now() + 5_000);
  await utimes(filePath, later, later);
}

/** Emit and pull; returns the emitted plan (with planPath) and the receipt tmp root. */
export async function deliverJudge(root, sources) {
  const plan = await emitJudgeWorkOrder(sources);
  const receiptTmpRoot = path.join(root, "tmp");
  await pullWorkOrder({ ref: plan.workOrderRef, digest: plan.workOrderDigest, execution: plan.executionIdentity, cwd: root, tmpRoots: [receiptTmpRoot], receiptTmpRoot });
  return { plan, receiptTmpRoot };
}
