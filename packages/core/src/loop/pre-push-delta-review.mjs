/**
 * pre-push-delta-review.mjs: deterministic checks for the pre-push reviewer's
 * delta mode (skills/docs/pre-pr-review-contract.md, PRE-PUSH-DELTA-* rules).
 *
 * Delta mode runs one fresh reviewer between the gate fixer's commit of a
 * judge act-list fix and its push. This module owns the trigger predicate, the
 * pinned-baseline sequence, the neutral delta input, the result validator, the
 * exit/bound decision and the freshness check.
 *
 * Pure and offline: no file reads, no git, no network. A delta result is local
 * evidence only; nothing here writes a gate artifact, comment or thread.
 */
import { createHash } from "node:crypto";

import { parseRepoSlug } from "../github/repo-slug.mjs";
import { severityRank, VALID_SEVERITIES, normalizeSeverity } from "./gate-fanin.mjs";
import { recordedSkipReason, siteCoverageGaps } from "./fixer-disposition.mjs";
import { sha256Hex } from "./review-dispatch-plan.mjs";

/** Select a complete new binding; digest-only historical records remain legacy. */
export function deltaCoverageBinding(value, expected) {
  if (!expected && !["coverageProtocol", "handbackBytesDigest", "origin"].some((key) => Object.hasOwn(value ?? {}, key))) return null;
  const { coverageProtocol, siteCoverageDigest, handbackBytesDigest, origin } = value ?? {};
  const ref = typeof origin?.workOrderRef === "string" && /^fixer:([^/\s#]+\/[^/\s#]+)#[1-9]\d*:(?:[a-f0-9]{40}|[a-f0-9]{64}):f\d+-[a-f0-9]{8}$/.exec(origin.workOrderRef);
  if (coverageProtocol !== "pulled_commit_only_v1"
    || ![siteCoverageDigest, handbackBytesDigest, origin?.workOrderDigest, origin?.executionIdentity, origin?.workOrderRef].every((field) => typeof field === "string")
    || !/^[a-f0-9]{64}$/.test(siteCoverageDigest ?? "")
    || !/^[a-f0-9]{64}$/.test(handbackBytesDigest ?? "") || !/^sha256:[a-f0-9]{64}$/.test(origin?.workOrderDigest ?? "")
    || !/^f\d+-[a-f0-9]{8}$/.test(origin?.executionIdentity ?? "")
    || !ref
    || !origin.workOrderRef.endsWith(`:${origin.executionIdentity}`) || Object.keys(origin).sort().join() !== "executionIdentity,workOrderDigest,workOrderRef") {
    throw new Error("Delta coverage binding is missing or malformed");
  }
  parseRepoSlug(ref[1], { errorMessage: "Delta coverage binding is missing or malformed" });
  const binding = { coverageProtocol, siteCoverageDigest, handbackBytesDigest, origin };
  if (expected && sha256Hex(binding) !== sha256Hex(expected)) throw new Error("Delta coverage binding differs from the authenticated current handback");
  return binding;
}

/** At most this many delta review invocations per sequence. */
export const DELTA_MAX_INVOCATIONS = 3;

export const DELTA_ITEM_STATUSES = Object.freeze(["resolved", "not_resolved", "cannot_verify"]);
export const DELTA_OUTCOMES = Object.freeze(["locally_clear", "needs_fix", "bounded_out"]);

/** The adversarial-enumeration checklist floor, shared with full mode. */
export const DELTA_CHECKLIST = Object.freeze([
  "errno classes (missing, permission, not-a-directory, already-exists)",
  "symlink handling for both a file target and a directory target",
  "rename and move across the seam",
  "empty input and empty file",
  "malformed input",
  "path normalization (relative, absolute, .., trailing slash)",
]);

/**
 * The judge's authorized remediation and its site query ride each act item into
 * the delta input, so the reviewer checks the edit against the remedy text and
 * reports a same-class site as residue of the act item.
 */
const REMEDIATION_TEXT_FIELDS = Object.freeze(["authorizedRemediation", "defectClass", "siteQuery", "defectKind"]);
const REMEDIATION_LIST_FIELDS = Object.freeze(["acceptedForms", "rejectedForms", "statedSurfaces"]);

const MEDIUM_RANK = severityRank("medium");

// Residue of an act item rides the same fix commit. It blocks until a skip reason is recorded for that site.
function isOpenResidue(finding) {
  return nonEmpty(finding?.residueOf) && !nonEmpty(finding?.skipReason);
}

/**
 * The synthetic hit that result mode adds when the stale-surface list was truncated. A
 * `newFindings[]` entry or a skipped `siteCoverage[]` site (with a reason) naming this token addresses it.
 */
export const STALE_SURFACE_TRUNCATED_SITE = "stale-surface-hits-truncated";
export const staleSurfaceTruncatedHit = () => ({ kind: "truncated", needle: STALE_SURFACE_TRUNCATED_SITE, file: STALE_SURFACE_TRUNCATED_SITE, line: 0, site: STALE_SURFACE_TRUNCATED_SITE });

// The path must stand alone as a token: `.claude/skills/x.md` or `docs/README.md` do not name `skills/x.md` or `README.md`.
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const namesPath = (text, file) => new RegExp(`(?<![^\\s\`"'(\\[{<])${escapeRegExp(file)}(?![^\\s\`"')\\]}>:,;.!?])`, "u").test(text);

/**
 * Stale-surface hits that neither a `newFindings[]` entry (its summary, site or evidence names the
 * hit file) nor a skipped site in `siteCoverage[]` (with a reason) addresses. A skipped site that
 * names a bare file addresses every hit in that file. A skipped site with a `:line` or `:start-end`
 * suffix addresses only a hit on that line or inside that range.
 */
export function unaddressedStaleSurfaceHits(hits, { newFindings = [], siteCoverage = [] } = {}) {
  const findingText = newFindings.map((f) => [f?.summary, f?.site, ...(Array.isArray(f?.evidence) ? f.evidence : [])].join("\n"));
  const skipped = siteCoverage.flatMap((record) => (record?.sites ?? []).filter((s) => s?.status === "skipped" && nonEmpty(s.reason)).map((s) => String(s.site).trim()));
  const skipAddresses = (site, hit) => {
    if (site === hit.file) return true;
    const m = /^(.*):(\d+)(?:-(\d+))?$/u.exec(site);
    return m !== null && m[1] === hit.file && hit.line >= Number(m[2]) && hit.line <= Number(m[3] ?? m[2]);
  };
  return (hits ?? []).filter((hit) => !findingText.some((t) => namesPath(t, hit.file)) && !skipped.some((site) => skipAddresses(site, hit)));
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Trigger predicate. Delta mode runs only for a committed, not yet pushed fix
 * of a non-empty judge act list or of a non-empty set of unresolved review
 * threads (the thread route). Every other push gets no delta review.
 * @param {{ actItemCount?: number, threadItemCount?: number, fixCommitted?: boolean, fixPushed?: boolean }} input
 * @returns {"delta"|"none"}
 */
export function resolveDeltaTrigger({ actItemCount = 0, threadItemCount = 0, fixCommitted = false, fixPushed = false } = {}) {
  const hasItems = [actItemCount, threadItemCount].some((count) => Number.isInteger(count) && count > 0);
  return hasItems && fixCommitted === true && fixPushed !== true ? "delta" : "none";
}

/**
 * Thread route: reduce successful `list-review-threads --unresolved-only` output for `repo#pr`
 * to a judge-act-list-shaped array, one act item per unresolved thread, `ref` = the `threadId`.
 * @param {unknown} payload
 * @param {{ repo: string, pr: number|string }} target
 */
export function threadsToActList(payload, { repo, pr } = {}) {
  const threads = /** @type {any} */ (payload)?.threads;
  if (/** @type {any} */ (payload)?.ok !== true || !Array.isArray(threads) || /** @type {any} */ (payload).repo !== repo || Number(/** @type {any} */ (payload).pr) !== Number(pr)
    || !threads.every((thread) => thread?.isResolved === false && nonEmpty(thread?.threadId))) {
    throw new Error(`threads file is not successful list-review-threads --unresolved-only output for ${repo}#${pr}`);
  }
  // Sorted by threadId so actSetId is stable for the same thread set, whatever the capture order.
  return [...threads].sort((a, b) => (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0)).map((thread) => ({
    ref: thread.threadId,
    angle: "review-thread",
    summary: nonEmpty(thread.body) ? thread.body.trim() : "",
    judgeDisposition: "act",
    ...(nonEmpty(thread.path) ? { file: thread.path } : {}),
    ...(Number.isInteger(thread.line) ? { line: thread.line } : {}),
  }));
}

/**
 * Reduce a judge act list (the `judge-pass --out` array) to the neutral act
 * items the reviewer may see. Only allow-listed fields pass, so reviewer
 * verdicts, "clean" claims and diff bytes never reach the delta input.
 * @param {unknown} actList
 */
export function toDeltaActItems(actList) {
  if (!Array.isArray(actList) || actList.length === 0) {
    throw new Error("delta review requires a non-empty judge act list");
  }
  const items = actList.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`act list entry ${index} is not an object`);
    if (entry.judgeDisposition !== "act") {
      throw new Error(`act list entry ${index} has judgeDisposition ${JSON.stringify(entry.judgeDisposition)}, expected "act"`);
    }
    // Real judge act entries carry the ledger `fingerprint`; `ref` wins when set.
    const ledgerRef = [entry.ref, entry.fingerprint].find(nonEmpty);
    const item = {
      ref: ledgerRef ? ledgerRef.trim() : `act-${index + 1}`,
      angle: nonEmpty(entry.angle) ? entry.angle.trim() : null,
      severity: normalizeSeverity(entry.severity) ?? null,
      summary: nonEmpty(entry.summary) ? entry.summary.trim() : "",
      judgeDisposition: "act",
    };
    if (nonEmpty(entry.judgeRationale)) item.judgeRationale = entry.judgeRationale.trim();
    // The site coverage record keys on the ledger fingerprint, which a repeated-fingerprint ref suffix would hide.
    if (nonEmpty(entry.fingerprint)) item.fingerprint = entry.fingerprint.trim();
    for (const key of REMEDIATION_TEXT_FIELDS) if (nonEmpty(entry[key])) item[key] = entry[key].trim();
    for (const key of REMEDIATION_LIST_FIELDS) if (Array.isArray(entry[key]) && entry[key].length > 0) item[key] = entry[key].filter(nonEmpty).map((v) => v.trim());
    if (Array.isArray(entry.siblingRemediations) && entry.siblingRemediations.length > 0) item.siblingRemediations = entry.siblingRemediations;
    if (nonEmpty(entry.file)) item.file = entry.file.trim();
    if (Number.isInteger(entry.line)) item.line = entry.line;
    return item;
  });
  // A fingerprint hashes only file and summary, so entries from different clusters
  // can share one; suffix the repeats deterministically. Explicit refs stay unique.
  const refs = new Set();
  const fingerprintCounts = new Map();
  items.forEach((item, index) => {
    const entry = actList[index];
    if (!nonEmpty(entry.ref) && nonEmpty(entry.fingerprint)) {
      const count = (fingerprintCounts.get(item.ref) ?? 0) + 1;
      fingerprintCounts.set(item.ref, count);
      if (count > 1) item.ref = `${item.ref}#${count}`;
    }
    if (refs.has(item.ref)) throw new Error(`act list has duplicate ref ${JSON.stringify(item.ref)}`);
    refs.add(item.ref);
  });
  return items;
}

function nonEmptyStrings(value) {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmpty);
}

/**
 * Open a delta sequence for one gate round. The baseline is the head that gate
 * round reviewed and stays pinned for every invocation in the sequence; a new
 * gate round opens a new sequence.
 * @param {{ reviewBaselineHead: string, actList: unknown }} input
 */
export function startDeltaSequence({ reviewBaselineHead, actList } = {}) {
  if (!nonEmpty(reviewBaselineHead)) throw new Error("delta sequence requires reviewBaselineHead");
  const actItems = toDeltaActItems(actList);
  const actSetId = createHash("sha256")
    .update(JSON.stringify(actItems.map((item) => {
      const { ref, angle, severity, file, line, summary } = item;
      // A thread-route summary is a body excerpt that varies with --body-max, so it stays out of the hash.
      const base = angle === "review-thread" ? [ref, angle, severity, file ?? null, line ?? null] : [ref, angle, severity, file ?? null, line ?? null, summary];
      // Scope fields join the hash only when present, so a legacy act list keeps its id.
      const scope = [...REMEDIATION_TEXT_FIELDS, ...REMEDIATION_LIST_FIELDS, "siblingRemediations"].filter((key) => item[key] !== undefined).map((key) => [key, item[key]]);
      return scope.length > 0 ? [...base, scope] : base;
    })))
    .digest("hex")
    .slice(0, 16);
  return Object.freeze({ reviewBaselineHead: reviewBaselineHead.trim(), actSetId, actItems });
}

/**
 * Build the reviewer input for one invocation. The range is always
 * `reviewBaselineHead..candidateHead` (cumulative), never the last fix only.
 * The reviewer reads the diff from the worktree; the input carries no diff.
 * `siteCoverage` retains the fixer's raw site coverage record from the `commit_only` handback;
 * the reviewer reads the recorded skip reasons from it.
 * @param {{ sequence: ReturnType<typeof startDeltaSequence>, candidateHead: string, specIdentity?: string|null, siteCoverage?: object[] }} input
 */
export function buildDeltaInput({ sequence, candidateHead, specIdentity = null, siteCoverage = [], coverageBinding, roundAngles = [], staleSurfaceHits = [], staleSurfaceTruncated = false, truncatedNeedles = [] } = {}) {
  if (!sequence || !nonEmpty(sequence.reviewBaselineHead)) throw new Error("buildDeltaInput requires a delta sequence");
  if (!nonEmpty(candidateHead)) throw new Error("buildDeltaInput requires candidateHead");
  const head = candidateHead.trim();
  const binding = coverageBinding ? deltaCoverageBinding(coverageBinding) : {};
  if (coverageBinding && binding.siteCoverageDigest !== sha256Hex(siteCoverage).slice(7)) throw new Error("Delta coverage binding differs from raw coverage");
  return {
    ...binding,
    mode: "delta",
    reviewBaselineHead: sequence.reviewBaselineHead,
    candidateHead: head,
    diffRange: `${sequence.reviewBaselineHead}..${head}`,
    actSetId: sequence.actSetId,
    actItems: sequence.actItems.map((item) => ({ ...item })),
    specIdentity: nonEmpty(specIdentity) ? specIdentity.trim() : null,
    siteCoverage,
    // The act items' angles plus the reviewed gate round's angles (provenance.perAngle).
    surfaceHints: [...new Set([...sequence.actItems.map((item) => item.angle), ...roundAngles].filter(Boolean))],
    staleSurfaceHits,
    // Additive: present only when a cap dropped hits; the reviewer must then address the gap (STALE_SURFACE_TRUNCATED_SITE).
    ...(staleSurfaceTruncated ? { staleSurfaceTruncated: true } : {}),
    // Additive: the identifiers dropped as too common, so the reviewer can check them by name.
    ...(truncatedNeedles.length > 0 ? { truncatedNeedles } : {}),
    checklist: [...DELTA_CHECKLIST],
    // The DeltaPrePushReviewResult template the reviewer fills in; validateDeltaResult checks it.
    resultShape: {
      ...binding,
      reviewBaselineHead: sequence.reviewBaselineHead,
      candidateHead: head,
      actSetId: sequence.actSetId,
      actionableItems: [{ ref: "<act item ref>", status: DELTA_ITEM_STATUSES.join("|"), evidence: ["<non-empty string>"] }],
      newFindings: [{
        severity: [...VALID_SEVERITIES].join("|"),
        summary: "<non-empty string>",
        evidence: ["<non-empty string>"],
        // Set for a same-class site of an act item; skipReason copies the reason that input.siteCoverage records for that site.
        residueOf: "<act item ref, optional>",
        site: "<site name in input.siteCoverage, required with skipReason>",
        skipReason: "<non-empty string, optional>",
      }],
      widenedReads: [{ path: "<widened path>", reason: "<why the read was needed>" }],
      outcome: DELTA_OUTCOMES.join("|"),
    },
  };
}

/**
 * The outcome the item statuses and new findings imply: locally_clear only when
 * every act item is resolved and no new finding is medium or higher.
 * @param {{ actionableItems?: Array<{status?: string}>, newFindings?: Array<{severity?: string}> }} result
 * @returns {"locally_clear"|"needs_fix"}
 */
export function deriveDeltaOutcome(result) {
  const items = Array.isArray(result?.actionableItems) ? result.actionableItems : [];
  const findings = Array.isArray(result?.newFindings) ? result.newFindings : [];
  const allResolved = items.length > 0 && items.every((item) => item?.status === "resolved");
  const blockingFinding = findings.some((f) => isOpenResidue(f) || (!nonEmpty(f?.residueOf) && severityRank(f?.severity) <= MEDIUM_RANK));
  return allResolved && !blockingFinding ? "locally_clear" : "needs_fix";
}

/**
 * Validate a DeltaPrePushReviewResult against its sequence. Returns the list of
 * problems; an empty list means the result is well formed.
 * Every act item with a site query needs a coverage record, and each `skipReason` must equal the
 * reason recorded for its site. An omitted `siteCoverage` counts as []. `membershipOnly` skips both
 * checks, for callers that only confirm the result belongs to the act list and head.
 * @param {unknown} result
 * @param {{ sequence: ReturnType<typeof startDeltaSequence>, siteCoverage?: object[], membershipOnly?: boolean }} context
 * @returns {string[]}
 */
export function validateDeltaResult(result, { sequence, siteCoverage = [], validationCoverage = siteCoverage, coverageBinding, membershipOnly = false, staleSurfaceHits = [] } = {}) {
  const errors = [];
  if (!result || typeof result !== "object") return ["result must be an object"];
  try {
    const binding = deltaCoverageBinding(result, coverageBinding);
    if (binding && !membershipOnly && binding.siteCoverageDigest !== sha256Hex(siteCoverage).slice(7)) errors.push("Delta coverage binding differs from raw coverage");
  } catch (error) { errors.push(error.message); }
  if (result.reviewBaselineHead !== sequence?.reviewBaselineHead) {
    errors.push(`reviewBaselineHead ${JSON.stringify(result.reviewBaselineHead)} does not match the pinned baseline ${JSON.stringify(sequence?.reviewBaselineHead)}`);
  }
  if (!nonEmpty(result.candidateHead)) errors.push("candidateHead is required");
  if (result.actSetId !== sequence?.actSetId) {
    errors.push(`actSetId ${JSON.stringify(result.actSetId)} does not match the sequence act set ${JSON.stringify(sequence?.actSetId)}`);
  }

  const items = Array.isArray(result.actionableItems) ? result.actionableItems : null;
  if (!items) errors.push("actionableItems[] is required");
  const expectedRefs = new Set((sequence?.actItems ?? []).map((item) => item.ref));
  const seen = new Set();
  for (const [i, item] of (items ?? []).entries()) {
    if (!expectedRefs.has(item?.ref)) errors.push(`actionableItems[${i}].ref ${JSON.stringify(item?.ref)} is not in the act set`);
    else if (seen.has(item.ref)) errors.push(`actionableItems[${i}].ref ${JSON.stringify(item.ref)} is a duplicate`);
    else seen.add(item.ref);
    if (item?.status === undefined) errors.push(`actionableItems[${i}].status is missing`);
    else if (!DELTA_ITEM_STATUSES.includes(item.status)) errors.push(`actionableItems[${i}].status ${JSON.stringify(item.status)} is unknown`);
    if (!nonEmptyStrings(item?.evidence)) errors.push(`actionableItems[${i}].evidence[] must be non-empty strings`);
  }
  for (const ref of expectedRefs) if (!seen.has(ref)) errors.push(`act item ${ref} has no status`);

  const findings = Array.isArray(result.newFindings) ? result.newFindings : null;
  if (!findings) errors.push("newFindings[] is required");
  for (const [i, f] of (findings ?? []).entries()) {
    if (!VALID_SEVERITIES.has(normalizeSeverity(f?.severity))) errors.push(`newFindings[${i}].severity ${JSON.stringify(f?.severity)} is unknown`);
    if (!nonEmpty(f?.summary)) errors.push(`newFindings[${i}].summary is required`);
    if (!nonEmptyStrings(f?.evidence)) errors.push(`newFindings[${i}].evidence[] must be non-empty strings`);
    // null is an absent optional field
    if (f?.residueOf != null && !expectedRefs.has(f.residueOf)) errors.push(`newFindings[${i}].residueOf ${JSON.stringify(f.residueOf)} is not in the act set`);
    if (f?.skipReason != null && (!nonEmpty(f.skipReason) || !nonEmpty(f.residueOf))) errors.push(`newFindings[${i}].skipReason needs residueOf and a non-empty reason`);
    if (!membershipOnly && nonEmpty(f?.skipReason) && expectedRefs.has(f.residueOf)) {
      const actItem = sequence.actItems.find((item) => item.ref === f.residueOf);
      const recorded = recordedSkipReason(validationCoverage, actItem.fingerprint ?? actItem.ref, nonEmpty(f.site) ? f.site.trim() : "");
      if (recorded !== f.skipReason.trim()) {
        errors.push(`PRE-PUSH-DELTA-RESIDUE: newFindings[${i}].skipReason must equal the reason recorded for site ${JSON.stringify(f.site)} of act item ${f.residueOf}: ${JSON.stringify(recorded)}`);
      }
    }
  }
  if (!membershipOnly) errors.push(...siteCoverageGaps(sequence?.actItems ?? [], validationCoverage));

  if (!Array.isArray(result.widenedReads)) errors.push("widenedReads[] is required (empty when nothing was widened)");
  else for (const [i, read] of result.widenedReads.entries()) {
    if (!nonEmpty(read?.path) || !nonEmpty(read?.reason)) errors.push(`widenedReads[${i}] needs a path and a reason`);
  }

  if (!DELTA_OUTCOMES.includes(result.outcome)) errors.push(`outcome ${JSON.stringify(result.outcome)} is unknown`);
  else if (result.outcome === "locally_clear" && deriveDeltaOutcome(result) !== "locally_clear") {
    errors.push("locally_clear requires every act item resolved and no new finding of severity medium or higher");
  } else if (result.outcome === "locally_clear" && !membershipOnly) {
    const open = unaddressedStaleSurfaceHits(staleSurfaceHits, { newFindings: findings ?? [], siteCoverage: validationCoverage });
    if (open.length > 0) errors.push(`PRE-PUSH-DELTA-RESULT: locally_clear leaves stale-surface hits unaddressed (a newFindings[] entry naming the file or a skipped siteCoverage[] site is required): ${open.map((h) => h.site).join(", ")}`);
  }
  return errors;
}

/**
 * Freshness: a result authorizes a push only for the head it reviewed.
 * @param {{ candidateHead?: string }} result
 * @param {string} currentHead the worktree HEAD read just before the push
 */
export function isDeltaResultFresh(result, currentHead) {
  return nonEmpty(result?.candidateHead) && nonEmpty(currentHead) && result.candidateHead.trim() === currentHead.trim();
}

const CONVERGED_SEVERITIES = Object.freeze(["low", "nit"]);
const FULL_SHA_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const isLowNitActList = (items) => Array.isArray(items) && items.length > 0
  && items.every((item) => CONVERGED_SEVERITIES.includes(/** @type {string} */ (normalizeSeverity(item?.severity))));

/**
 * Low/nit convergence of a draft_gate round (gate-review-sub-loop-contract.md, GATE-EXEC-LOW-NIT-CONVERGENCE).
 * A round whose open judge act items are ALL low or nit converges after one commit_only fixer pass whose
 * pre-push delta review is fresh and locally_clear. Any other act item (medium, high, question, unknown) or a
 * mixed list, an empty list, a non-draft_gate gate, or a stale or malformed delta result throws: the caller
 * keeps today's full round. No round count or cap input.
 * Returns the converged marker the draft_gate comment at `headSha` records.
 * @param {{ gate?: string, headSha?: string, roundActItems?: unknown, converged?: { fixerCommit?: string, actList?: unknown, deltaResult?: any } }} input
 * @returns {{ fixerCommit: string, deltaDigest: string }}
 */
export function composeConvergedDraftGate({ gate, headSha, roundActItems, converged } = {}) {
  if (gate !== "draft_gate") throw new Error(`converged verdict applies to draft_gate only, got ${JSON.stringify(gate)}`);
  if (!FULL_SHA_RE.test(headSha ?? "")) throw new Error("converged verdict requires the full reviewed head sha");
  const fixerCommit = converged?.fixerCommit;
  if (!FULL_SHA_RE.test(fixerCommit ?? "") || fixerCommit === headSha) throw new Error("converged.fixerCommit must be a full sha different from the reviewed head");
  if (!isLowNitActList(roundActItems)) throw new Error("converged verdict requires a non-empty round act list of only low or nit items; a medium, high, question, unknown or mixed list needs a full round");
  const summaries = (items) => items.map((item) => String(item?.summary).trim()).sort().join("\n");
  if (!isLowNitActList(converged.actList) || summaries(converged.actList) !== summaries(/** @type {any[]} */ (roundActItems))) {
    throw new Error("converged.actList must be the round's non-empty low/nit act list (same items as the posted act items)");
  }
  const result = converged.deltaResult;
  const errors = validateDeltaResult(result, { sequence: startDeltaSequence({ reviewBaselineHead: headSha, actList: converged.actList }), membershipOnly: true });
  if (errors.length > 0) throw new Error(`converged.deltaResult is invalid: ${errors.join("; ")}`);
  if (result.outcome !== "locally_clear") throw new Error("converged.deltaResult must be locally_clear");
  if (!isDeltaResultFresh(result, fixerCommit)) throw new Error("converged.deltaResult is stale: candidateHead is not the fixer commit");
  return { fixerCommit, deltaDigest: sha256Hex(result) };
}

/**
 * Decide the next step after invocation `invocation` (1-based) of a sequence.
 * - fresh, valid, locally_clear: push.
 * - otherwise, below the bound: fix (or re-review a moved head) and review again.
 * - otherwise, at the bound: bounded_out; push the committed candidate into the
 *   normal gate path with the residual evidence. No fourth review runs. The
 *   bound takes precedence over freshness: a stale result at the bound also
 *   ends bounded_out, which authorizes nothing and claims no success.
 * @param {{ sequence: ReturnType<typeof startDeltaSequence>, result: unknown, invocation: number, currentHead: string, siteCoverage?: object[] }} input
 */
export function decideDeltaNextStep({ sequence, result, invocation, currentHead, siteCoverage, validationCoverage, coverageBinding, staleSurfaceHits } = {}) {
  if (!Number.isInteger(invocation) || invocation < 1 || invocation > DELTA_MAX_INVOCATIONS) {
    throw new Error(`invocation must be an integer in 1..${DELTA_MAX_INVOCATIONS}`);
  }
  const binding = deltaCoverageBinding(result, coverageBinding);
  if (binding && binding.siteCoverageDigest !== sha256Hex(siteCoverage ?? []).slice(7)) throw new Error("Delta coverage binding differs from raw coverage");
  const errors = validateDeltaResult(result, { sequence, siteCoverage, validationCoverage, coverageBinding, staleSurfaceHits });
  const fresh = isDeltaResultFresh(/** @type {any} */ (result), currentHead);
  const clear = errors.length === 0 && fresh && /** @type {any} */ (result).outcome === "locally_clear";
  if (clear) return { ...binding, outcome: "locally_clear", nextStep: "push", locallyClear: true, errors, fresh };
  if (invocation >= DELTA_MAX_INVOCATIONS) {
    return { ...binding, outcome: "bounded_out", nextStep: "push_to_gate", locallyClear: false, errors, fresh };
  }
  return {
    ...binding,
    outcome: "needs_fix",
    nextStep: fresh ? "fix_and_rereview" : "rereview_current_head",
    locallyClear: false,
    errors,
    fresh,
  };
}
