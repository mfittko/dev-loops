/**
 * Carried gate verdicts across a base-only merge (issue 2752 slice 2, ADR 0156,
 * GATE-EXEC-BASE-MERGE-VERDICT-CARRY). A clean verdict marker at an earlier head
 * (the origin head) is presented as current-head only when re-classifying origin..head
 * yields `carry_verdict` AND a durable carried-heads record holds evidence for that
 * head that equals the recomputed one. The coordination path records (`record: true`);
 * merge-pr only reads, so it never accepts a carry nobody recorded.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateBaseMergeCarryEvidence } from "@dev-loops/core/loop/base-merge-verdict-carry";

import { resolveGateArtifactTmpRoot } from "../loop/_repo-root-resolver.mjs";
import { buildGateArtifactPath } from "./_gate-artifact-paths.mjs";
import { computeBaseMergeCarry } from "./classify-base-merge-carry.mjs";

const FULL_SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function buildCarriedHeadsPath({ repo, pr, gate, originHead, tmpRoot = "tmp" }) {
  return buildGateArtifactPath({ repo, pr, gate, headSha: originHead, tmpRoot, dir: "carried-heads", suffix: ".carried-heads.json" });
}

export async function readCarriedHeads(file) {
  try {
    const record = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(record?.carried) ? record : null;
  } catch {
    return null; // ponytail: absent or unreadable record means no carry (fail closed)
  }
}

async function upsertCarriedHead(file, { gate, originHead, evidence }) {
  const record = (await readCarriedHeads(file)) ?? { gate, originHead, carried: [] };
  const entry = { headSha: evidence.newHead, decision: evidence.decision, evidence };
  record.carried = [...record.carried.filter((e) => e.headSha !== entry.headSha), entry];
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/**
 * @returns {Promise<object>} the marker, rewritten to the current head with `carriedFrom` when
 * the verdict carries, else the marker unchanged.
 */
export async function carryGateMarker(marker, { gate, repo, pr, currentHeadSha, baseRef, repoRoot, record = false, runGit }) {
  const origin = marker?.headSha;
  if (!marker?.visible || marker.verdict !== "clean" || marker.contractComplete !== true) return marker;
  if (!FULL_SHA_RE.test(origin ?? "") || !FULL_SHA_RE.test(currentHeadSha ?? "") || origin === currentHeadSha || !baseRef) return marker;
  const evidence = await computeBaseMergeCarry({ prevHead: origin, headSha: currentHeadSha, baseRef, repoRoot, ...(runGit ? { runGit } : {}) });
  if (evidence.decision !== "carry_verdict") return marker;
  const file = path.resolve(repoRoot, buildCarriedHeadsPath({ repo, pr, gate, originHead: origin, tmpRoot: resolveGateArtifactTmpRoot(repoRoot) }));
  if (record) await upsertCarriedHead(file, { gate, originHead: origin, evidence });
  const entry = (await readCarriedHeads(file))?.carried.find((e) => e.headSha === currentHeadSha);
  const valid = entry && validateBaseMergeCarryEvidence(entry.evidence, { expectedSourceHead: origin, expectedNewHead: currentHeadSha }).ok
    && JSON.stringify(entry.evidence) === JSON.stringify(evidence);
  return valid ? { ...marker, headSha: currentHeadSha, carriedFrom: origin } : marker;
}
