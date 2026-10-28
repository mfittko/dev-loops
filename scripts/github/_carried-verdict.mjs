/**
 * Carried gate verdicts across a base-only merge (issue 2752 slice 2, ADR 0156,
 * GATE-EXEC-BASE-MERGE-VERDICT-CARRY). A clean verdict marker at an earlier head
 * (the origin head) is presented as current-head only when re-classifying origin..head
 * yields `carry_verdict` AND a GitHub-visible carried-heads record (a hidden-marker PR comment,
 * ADR 0186) holds an entry for the current head whose evidence equals the recomputed evidence.
 * The coordination path records (`record: true`); every other reader only reads, so it never
 * accepts a carry nobody recorded. The record holds heads, decisions and classifier evidence only.
 */
import { createHash } from "node:crypto";

import { validateBaseMergeCarryEvidence } from "@dev-loops/core/loop/base-merge-verdict-carry";

import { isGhBinaryMissing, restFetchPrView } from "./_gh-rest-fallback.mjs";
import { computeBaseMergeCarry } from "./classify-base-merge-carry.mjs";

const FULL_SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const MAX_ENTRIES = 20;
// The record stores a digest of the classifier evidence, never the raw blob and path lists.
export const evidenceDigest = (evidence) => createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
const RECORD_RE = /<!-- dev-loops:carried-heads:v1 (\{.*\}) -->/s;

export function renderCarriedHeadsBody(entries) {
  // `>` is escaped so the JSON can never close the HTML comment early.
  return `<!-- dev-loops:carried-heads:v1 ${JSON.stringify({ entries }).replace(/>/g, "\\u003e")} -->\nCarried gate verdict heads (machine record, see ADR 0186).`;
}

function recordComment(comments) {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const match = RECORD_RE.exec(comments[i]?.body ?? "");
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed?.entries)) return { comment: comments[i], entries: parsed.entries.filter((e) => e && typeof e === "object") };
    } catch { /* ponytail: an unparseable record is no record (fail closed) */ }
  }
  return { comment: null, entries: [] };
}

export const parseCarriedHeads = (comments) => recordComment(comments).entries;

async function upsertCarriedHead({ repo, pr, comments, entry }, runJson) {
  const { comment, entries } = recordComment(comments);
  // Bounded record: per gate, only entries for the current origin head survive (another gate's entries are
  // untouched), capped at MAX_ENTRIES, so the comment stays far below the GitHub body limit. A pruned head
  // is simply re-recorded on its next carry.
  const kept = entries.filter((e) => (e.gate !== entry.gate || e.originHead === entry.originHead) && !(e.gate === entry.gate && e.headSha === entry.headSha));
  const body = renderCarriedHeadsBody([...kept, entry].slice(-MAX_ENTRIES));
  const saved = comment?.id
    ? await runJson(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${comment.id}`, "-f", `body=${body}`])
    : await runJson(["api", "-X", "POST", `repos/${repo}/issues/${pr}/comments`, "-f", `body=${body}`]);
  // Later calls in the same run (the second gate) see the entry just written.
  comments.push({ id: saved?.id ?? comment?.id, body });
}

// The candidate shape under which carryGateMarker may carry (baseRef aside).
export function isCarryCandidate(marker, currentHeadSha) {
  const origin = marker?.headSha;
  return Boolean(marker?.visible) && marker.verdict === "clean" && marker.contractComplete === true
    && FULL_SHA_RE.test(origin ?? "") && FULL_SHA_RE.test(currentHeadSha ?? "") && origin !== currentHeadSha;
}

/**
 * @returns {Promise<object>} the marker, rewritten to the current head with `carriedFrom` when
 * the verdict carries, else the marker unchanged.
 */
export async function carryGateMarker(marker, { gate, currentHeadSha, baseRef, repoRoot, recorded = [], record = null }) {
  const origin = marker?.headSha;
  if (!isCarryCandidate(marker, currentHeadSha) || !baseRef) return marker;
  const evidence = await computeBaseMergeCarry({ prevHead: origin, headSha: currentHeadSha, baseRef, repoRoot });
  const valid = evidence.decision === "carry_verdict"
    && validateBaseMergeCarryEvidence(evidence, { expectedSourceHead: origin, expectedNewHead: currentHeadSha }).ok;
  if (!valid) return marker;
  const carried = { ...marker, headSha: currentHeadSha, carriedFrom: origin };
  const entry = recorded.find((e) => e.gate === gate && e.originHead === origin && e.headSha === currentHeadSha);
  const digest = evidenceDigest(evidence);
  if (entry) return entry.evidenceDigest === digest ? carried : marker;
  if (!record) return marker;
  try {
    await record({ gate, originHead: origin, headSha: currentHeadSha, decision: evidence.decision, evidenceDigest: digest });
  } catch {
    return marker; // fail closed: an unwritable record costs one gate round, never a crashed detector
  }
  return carried;
}

/**
 * The single carry seam for both gate-evidence readers: resolves the PR base ref (gh, then the
 * REST fallback when the gh binary is missing) and runs carryGateMarker against the posted
 * carried-heads record. `runJson(args)` runs gh and parses JSON. `comments` is the issue-comment
 * list (pass a copy: a successful record appends to it).
 */
export async function carryFromPostedVerdict(candidate, { gate, repo, pr, currentHeadSha, repoRoot, env, runJson, comments, record = false }) {
  if (!isCarryCandidate(candidate, currentHeadSha)) return candidate;
  let view = null;
  try {
    view = await runJson(["pr", "view", String(pr), "--repo", repo, "--json", "baseRefName"]);
  } catch (error) {
    if (isGhBinaryMissing(error)) view = await restFetchPrView(repo, pr, env).catch(() => null);
  }
  const name = typeof view?.baseRefName === "string" ? view.baseRefName.trim() : "";
  return carryGateMarker(candidate, {
    gate, currentHeadSha, repoRoot, baseRef: name ? `origin/${name}` : null,
    recorded: parseCarriedHeads(comments),
    record: record ? (entry) => upsertCarriedHead({ repo, pr, comments, entry }, runJson) : null,
  });
}
