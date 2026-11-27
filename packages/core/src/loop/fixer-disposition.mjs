// GATE-EXEC-FIXER-DISPOSITION-BOUNDARY (skills/docs/gate-review-sub-loop-contract.md):
// fail closed when a fixer push leaves the review threads it claims to have
// tackled incomplete (missing evidence, uncontained commit, unreplied, or
// unresolved). This module is a PURE evaluator — every GitHub/git fact
// (live thread state, commit containment) is injected as data, never fetched
// here, so the same decision is shared verbatim across every harness.

import { guardCommentBodyNoIssuePrIds } from "../github/comment-id-guard.mjs";
import { sanitizeCopilotSummonTokens } from "../github/copilot-helpers.mjs";
import { baseAngleName, normalizeSeverity, pastCapBlockers, resolveFindingFile } from "./gate-fanin.mjs";
import { sha256Hex } from "./review-dispatch-plan.mjs";

/** Disposition values a handoff entry may carry. "tackled" and "partially_fixed"
 * entries are auto-disposed by evaluateFixerDisposition, as is a "deferred" or
 * "rejected" entry that carries a replyNote; every other entry keeps its
 * existing judgment path untouched (see the boundary rule's scope note). */
export const FIXER_DISPOSITION_KIND = Object.freeze({
  TACKLED: "tackled",
  PARTIALLY_FIXED: "partially_fixed",
  DEFERRED: "deferred",
  REJECTED: "rejected",
});

/** The dispositions that claim a fixing commit in the PR head. */
export const FIXER_COMMIT_CLAIM_KINDS = Object.freeze([FIXER_DISPOSITION_KIND.TACKLED, FIXER_DISPOSITION_KIND.PARTIALLY_FIXED]);

/** The `Fixed in commit <sha>.` text. Throws for any entry kind other than `tackled`. */
export function composeFixedInCommitBody(entry) {
  if (entry.disposition !== FIXER_DISPOSITION_KIND.TACKLED) throw new Error(`A "Fixed in commit" body is composed for a tackled entry only, not "${entry.disposition}".`);
  return `Fixed in commit ${entry.fixingCommitSha}.`;
}

/**
 * The one reply body for a thread entry. A `Fixed in commit` body is composed for a `tackled` entry only.
 * Returns null for a `deferred` or `rejected` entry without a replyNote: that entry posts no reply of its own.
 */
export function composeFixerReplyBody(entry) {
  const { disposition, fixingCommitSha: sha, replyNote: note } = entry;
  if (disposition === FIXER_DISPOSITION_KIND.TACKLED) return `${composeFixedInCommitBody(entry)}${note ? ` ${note}` : ""}`;
  if (disposition === FIXER_DISPOSITION_KIND.PARTIALLY_FIXED) return `Partially fixed in commit ${sha}. Not done: ${note}`;
  if (!note) return null;
  return disposition === FIXER_DISPOSITION_KIND.DEFERRED ? `Deferred, no code change in this PR: ${note}` : `Not changed: ${note}`;
}

const REPLY_NOTE_MAX_CHARS = 500;

/**
 * Sanitize a reply note to the operator-focus carrier rules (control characters, angle brackets and backticks removed, at most
 * 500 characters) and refuse one the reply writer would refuse or alter: a bare issue/PR id, an operator-owned line or a Copilot summon token.
 * Returns the cleaned note; throws on a refusal.
 */
export function cleanReplyNote(value, label = "replyNote") {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.length > REPLY_NOTE_MAX_CHARS) throw new Error(`${label} is over ${REPLY_NOTE_MAX_CHARS} characters`);
  const note = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/[<>`]/g, "").replace(/~{3,}/g, "").replace(/ +/g, " ").trim();
  if (note === "") throw new Error(`${label} is empty after sanitizing`);
  if (sanitizeCopilotSummonTokens(note) !== note) throw new Error(`${label} carries a Copilot summon token that the reply writer rewrites; reword it`);
  guardCommentBodyNoIssuePrIds(note, { ref: label });
  return note;
}

export const FIXER_DISPOSITION_FAILED_STEP = Object.freeze({
  MISSING_FROM_HANDOFF: "missing_from_handoff",
  COMMIT_NOT_CONTAINED: "commit_not_contained",
  REPLY_MISSING: "reply_missing",
  NOT_RESOLVED: "not_resolved",
  // The thread is resolved and its replies cite only a short SHA of the fixing commit.
  RESOLVED_SHORT_SHA_REPLY: "resolved_short_sha_reply",
  // A thread with a replyNote is resolved and carries no composed reply, so the verifier cannot post one.
  RESOLVED_NOTE_REPLY_MISSING: "resolved_note_reply_missing",
  // A delivered tackled handoff for the live head with no verification checkpoint: verify-fixer-disposition never completed.
  NOT_VERIFIED: "not_verified",
  // The delta review of the fix left the thread not_resolved or cannot_verify; the status rides in `deltaStatus`.
  DELTA_BLOCKED: "delta_blocked",
  // A review-body marker comment exists for the fixing commit, but its author is not a trusted one (OWNER, MEMBER or COLLABORATOR human).
  MARKER_AUTHOR_UNTRUSTED: "marker_author_untrusted",
  // A review-body entry cites a fixing commit that the reviewed commit already contains, so it cannot be a fix for the review.
  FIX_NOT_AFTER_REVIEW: "fix_not_after_review",
});

/** The review node id a review-body handoff entry and `emit-fixer-work-order.mjs --review-id` both accept. */
export const REVIEW_NODE_ID_PATTERN = /^PRR_[A-Za-z0-9_-]+$/;

// The only legal next action while disposition is incomplete. Kept as a plain
// literal (not imported from pr-gate-coordination.mjs) so this module stays a
// dependency-free leaf; pr-gate-coordination.mjs's own PR_CHECKPOINT_ACTION
// token for this action is asserted (by test) to equal this same string.
export const COMPLETE_FIXER_DISPOSITION_ACTION = "complete_fixer_disposition";

// Broader than pr-gate-coordination's postDraftForbidden: the failure this
// boundary closes is the NEXT review/gate round opening over a dirty review
// surface, so every review-(re)request and gate-dispatch token is forbidden
// too, not just the draft/merge transition tokens. Literal tokens (not
// imported) for the same dependency-free-leaf reason as above.
export const FIXER_DISPOSITION_FORBIDDEN_ACTIONS = Object.freeze([
  "run_draft_gate",
  "reconcile_draft_gate",
  "mark_ready_for_review",
  "request_copilot_review",
  "rerequest_copilot_review",
  "run_pre_approval_gate",
  "await_final_human_approval",
  "declare_merge_ready",
]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

const SITE_STATUS = Object.freeze({ FIXED: "fixed", SKIPPED: "skipped" });

const RULE_ID_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;

/**
 * Optional site coverage of an act item's authorized remediation. `returnedSites`
 * are the sites the site query returned at the head. Every one needs a `sites`
 * entry that is `fixed`, or `skipped` with a reason. An `input_form` site that is
 * fixed names the test that covers that form. A query that returned nothing records a
 * `noSitesReason` instead of `returnedSites`. `ruleCitations` are the rule IDs
 * the fixer applied in place of a conflicting remediation.
 */
function normalizeSiteCoverage(entry, label, ruleIds) {
  const out = {};
  const rawSites = entry.sites === undefined ? [] : entry.sites;
  const returned = entry.returnedSites === undefined ? [] : entry.returnedSites;
  if (!Array.isArray(rawSites) || !Array.isArray(returned)) {
    throw new Error(`${label} sites and returnedSites must be arrays, not counts; expected returnedSites: ["<site>", ...] and sites: [{ "site": "<site>", "status": "fixed"|"skipped", "reason": "<required for skipped>" }, ...]`);
  }
  const sites = rawSites.map((site, i) => {
    // An input form is an input, so "" and " 12 " are kept verbatim; other sites are locations.
    const verbatim = site?.kind === "input_form" && typeof site.site === "string";
    if (!site || typeof site !== "object" || !(verbatim || isNonEmptyString(site.site))) throw new Error(`${label} sites[${i}] needs a site`);
    const status = typeof site.status === "string" ? site.status.trim().toLowerCase() : "";
    if (!Object.values(SITE_STATUS).includes(status)) throw new Error(`${label} site ${JSON.stringify(site.site)} has status ${JSON.stringify(site.status)}, expected fixed or skipped`);
    if (status === SITE_STATUS.SKIPPED && !isNonEmptyString(site.reason)) throw new Error(`${label} skipped site ${JSON.stringify(site.site)} records no skip reason`);
    if (status === SITE_STATUS.FIXED && site.kind === "input_form" && !isNonEmptyString(site.test)) {
      throw new Error(`${label} fixed input form ${JSON.stringify(site.site)} names no test`);
    }
    return {
      site: verbatim ? site.site : site.site.trim(),
      status,
      ...(isNonEmptyString(site.reason) ? { reason: site.reason.trim() } : {}),
      ...(site.kind === "input_form" ? { kind: "input_form" } : {}),
      ...(isNonEmptyString(site.test) ? { test: site.test.trim() } : {}),
    };
  });
  const disposed = new Set(sites.map((s) => s.site));
  if (disposed.size !== sites.length) {
    const dup = sites.find((s, i) => sites.findIndex((o) => o.site === s.site) !== i);
    throw new Error(`GATE-EXEC-REMEDIATION-SITE-QUERY: ${label} records site ${JSON.stringify(dup.site)} more than once`);
  }
  const returnedSites = returned.map((site) => {
    if (typeof site === "string" && sites.some((s) => s.kind === "input_form" && s.site === site)) return site;
    if (!isNonEmptyString(site)) throw new Error(`${label} returnedSites entries must be non-empty strings`);
    if (!disposed.has(site.trim())) throw new Error(`GATE-EXEC-REMEDIATION-SITE-QUERY: ${label} leaves returned site ${site.trim()} neither fixed nor skipped with a reason`);
    return site.trim();
  });
  if (sites.length > 0) out.sites = sites;
  if (returnedSites.length > 0) out.returnedSites = returnedSites;
  if (entry.noSitesReason !== undefined) {
    if (!isNonEmptyString(entry.noSitesReason)) throw new Error(`${label} noSitesReason must be a non-empty string`);
    out.noSitesReason = entry.noSitesReason.trim();
    if (out.noSitesReason.startsWith("FILL:")) throw new Error(`${label} noSitesReason is the unedited skeleton placeholder; replace it with the outcome of running the siteQuery`);
  }
  if (entry.sitelessSkipReason !== undefined) {
    if (!isNonEmptyString(entry.sitelessSkipReason)) throw new Error(`${label} sitelessSkipReason must be a non-empty string`);
    out.sitelessSkipReason = entry.sitelessSkipReason.trim();
    if (out.sitelessSkipReason.startsWith("FILL:")) throw new Error(`${label} sitelessSkipReason is the unedited skeleton placeholder; replace it with the reason or delete the field`);
  }
  if (entry.ruleCitations !== undefined) {
    if (!Array.isArray(entry.ruleCitations) || !entry.ruleCitations.every((id) => typeof id === "string" && RULE_ID_PATTERN.test(id.trim()))) {
      throw new Error(`${label} ruleCitations must be rule IDs such as LOCAL-COMMENT-DISCIPLINE`);
    }
    out.ruleCitations = entry.ruleCitations.map((id) => id.trim());
    const unknown = ruleIds ? out.ruleCitations.filter((id) => !ruleIds.has(id)) : [];
    if (unknown.length > 0) throw new Error(`${label} cites rule IDs that skills/docs/required-rules.json does not register: ${unknown.join(", ")}`);
  }
  return out;
}

/**
 * Site coverage keyed by act-item fingerprint. It covers threadless act items and rides
 * the `commit_only` handback, where no thread entry exists: `{ fingerprint, returnedSites, sites, ruleCitations?, noSitesReason?, sitelessSkipReason? }`.
 */
function normalizeSiteCoverageRecords(raw, ruleIds) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("Fixer handoff siteCoverage must be an array");
  const seen = new Set();
  return raw.map((item, index) => {
    if (!item || typeof item !== "object" || !isNonEmptyString(item.fingerprint)) {
      throw new Error(`Fixer handoff siteCoverage[${index}] is missing fingerprint`);
    }
    const fingerprint = item.fingerprint.trim();
    if (seen.has(fingerprint)) throw new Error(`Fixer handoff siteCoverage has a duplicate fingerprint: ${fingerprint}`);
    seen.add(fingerprint);
    return { fingerprint, ...normalizeSiteCoverage(item, `Fixer site coverage for ${fingerprint}`, ruleIds) };
  });
}

/**
 * Gaps between the act items' authorized remediations and a normalized site coverage record.
 * An act item with a `siteQuery` needs a record that lists the sites the query returned, or a `noSitesReason`.
 * A doc_lag item needs a fixed or skipped site for every `statedSurfaces` entry. A matcher
 * item (`acceptedForms` / `rejectedForms`) needs one fixed `input_form` site with a test per listed form.
 * @param {Array<object>} actItems delta act items (each with `fingerprint` or `ref`)
 * @param {Array<object>|undefined} siteCoverage normalized `siteCoverage` of a handoff
 * @param {Set<string>} [residualRefs] full-completion item refs authenticated by a bounded-out Delta decision
 * @returns {string[]}
 */
export function siteCoverageGaps(actItems, siteCoverage, residualRefs = new Set()) {
  const byFingerprint = new Map((siteCoverage ?? []).map((record) => [record.fingerprint, record]));
  const gaps = [];
  for (const item of actItems) {
    if (!isNonEmptyString(item.siteQuery)) continue;
    const key = item.fingerprint ?? item.ref;
    const record = byFingerprint.get(key);
    if (!record) {
      gaps.push(`act item ${key} has a site query and no site coverage record`);
      continue;
    }
    if (!record.returnedSites?.length && !record.noSitesReason) gaps.push(`act item ${key} records no returned sites and no noSitesReason for its site query`);
    const disposed = new Map((record.sites ?? []).map((site) => [site.site, site]));
    for (const surface of item.statedSurfaces ?? []) {
      if (!disposed.has(surface)) gaps.push(`act item ${key} records no fixed or skipped site for stated surface ${JSON.stringify(surface)}`);
    }
    for (const form of [...(item.acceptedForms ?? []), ...(item.rejectedForms ?? [])]) {
      const site = disposed.get(form);
      if (site?.kind !== "input_form") gaps.push(`act item ${key} records no input_form site for form ${JSON.stringify(form)}`);
      else if (residualRefs.has(item.ref ?? item.fingerprint) && site.status === SITE_STATUS.SKIPPED && isNonEmptyString(site.reason) && !site.reason.trim().startsWith("FILL:")) continue;
      else if (site.status !== SITE_STATUS.FIXED || !isNonEmptyString(site.test)) gaps.push(`act item ${key} input_form site ${JSON.stringify(form)} needs a fixed status and a test`);
    }
  }
  return gaps;
}

/** The recorded skip reason for a site of an act item, or null. A residue with no site (a PR-body item) is skipped only by the record's `sitelessSkipReason`; `noSitesReason` never skips it (issue 3364). */
export function recordedSkipReason(siteCoverage, fingerprint, site) {
  if (typeof site !== "string") return (siteCoverage ?? []).find((record) => record.fingerprint === fingerprint)?.sitelessSkipReason ?? null;
  const sites = (siteCoverage ?? []).find((record) => record.fingerprint === fingerprint)?.sites ?? [];
  // Resolve the exact site first, then filter by status, so a fixed exact form is not shadowed by a skipped trimmed location.
  const found = sites.find((s) => s.site === site) ?? sites.find((s) => s.kind !== "input_form" && s.site === site.trim());
  return found?.status === SITE_STATUS.SKIPPED ? (found.reason ?? null) : null;
}

/**
 * Validate + normalize a raw fixer-disposition handoff. Throws on any
 * structural gap the evaluator must never silently tolerate: a missing
 * headSha, a non-array dispositions field, a missing
 * threadId/fixingCommitSha/disposition on any entry, an unrecognized
 * disposition value, or a duplicate threadId across entries.
 *
 * Each entry also carries the optional site coverage fields `sites`, `returnedSites`, `noSitesReason`, `sitelessSkipReason` and
 * `ruleCitations`; the handoff may carry a top-level `siteCoverage[]`.
 *
 * @param {object} raw
 * @param {{ ruleIds?: Set<string> }} [options] ruleIds: the known rule ids that `ruleCitations` are checked against
 * @returns {{ headSha: string, dispositions: Array<{ threadId: string, fingerprint: string|null, fixingCommitSha: string, disposition: string, validation: string|null, sites?: object[], returnedSites?: string[], ruleCitations?: string[], noSitesReason?: string, sitelessSkipReason?: string }>, siteCoverage?: Array<{ fingerprint: string, returnedSites: string[], sites: object[], ruleCitations?: string[], noSitesReason?: string, sitelessSkipReason?: string }> }}
 */
export function normalizeFixerDispositionHandoff(raw, { ruleIds } = {}) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Fixer disposition handoff must be an object");
  }
  if (!isNonEmptyString(raw.headSha)) {
    throw new Error("Fixer disposition handoff is missing headSha");
  }
  if (raw.dispositions !== undefined && !Array.isArray(raw.dispositions)) {
    throw new Error("Fixer disposition handoff dispositions must be an array");
  }
  const rawDispositions = raw.dispositions ?? [];
  const seenThreadIds = new Set();
  const seenReviewIds = new Set();
  const dispositions = rawDispositions.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Fixer disposition handoff entry ${index} must be an object`);
    }
    if (entry.reviewId !== undefined) {
      // A review-body entry: exactly one of threadId and reviewId.
      if (entry.threadId !== undefined) throw new Error(`Fixer disposition handoff entry ${index} carries both threadId and reviewId; a review-body entry carries reviewId only`);
      const reviewId = isNonEmptyString(entry.reviewId) ? entry.reviewId.trim() : "";
      if (!REVIEW_NODE_ID_PATTERN.test(reviewId)) throw new Error(`Fixer disposition handoff entry ${index} reviewId is not a review node id (PRR_...)`);
      if (seenReviewIds.has(reviewId)) throw new Error(`Fixer disposition handoff has a duplicate reviewId: ${reviewId}`);
      seenReviewIds.add(reviewId);
      // The marker comment cites the commit in full, so the entry must carry the full 40-character SHA.
      if (!isNonEmptyString(entry.fixingCommitSha) || !/^[0-9a-fA-F]{40}$/.test(entry.fixingCommitSha.trim())) throw new Error(`Fixer disposition handoff entry for review ${reviewId} needs fixingCommitSha as the full 40-character SHA (git rev-parse <commit>)`);
      const disposition = isNonEmptyString(entry.disposition) ? entry.disposition.trim().toLowerCase() : "";
      if (disposition === FIXER_DISPOSITION_KIND.PARTIALLY_FIXED || !Object.values(FIXER_DISPOSITION_KIND).includes(disposition)) throw new Error(`Fixer disposition handoff entry for review ${reviewId} has a missing or unrecognized disposition: ${disposition}`);
      if (entry.replyNote !== undefined) throw new Error(`Fixer disposition handoff entry for review ${reviewId} carries a replyNote; a review-body entry takes none`);
      return { reviewId, fingerprint: null, fixingCommitSha: entry.fixingCommitSha.trim().toLowerCase(), disposition, validation: isNonEmptyString(entry.validation) ? entry.validation.trim() : null };
    }
    if (!isNonEmptyString(entry.threadId)) {
      throw new Error(`Fixer disposition handoff entry ${index} is missing threadId (or reviewId for a review-body entry)`);
    }
    const threadId = entry.threadId.trim();
    if (!/^PRRT_[A-Za-z0-9_-]+$/.test(threadId)) {
      throw new Error(`Fixer disposition handoff entry ${index} threadId ${threadId} is not a review-thread node id; a threadless act item gets no handoff entry`);
    }
    if (seenThreadIds.has(threadId)) {
      throw new Error(`Fixer disposition handoff has a duplicate threadId: ${threadId}`);
    }
    seenThreadIds.add(threadId);
    if (!isNonEmptyString(entry.fixingCommitSha)) {
      throw new Error(`Fixer disposition handoff entry for thread ${threadId} is missing fixingCommitSha`);
    }
    if (FIXER_COMMIT_CLAIM_KINDS.includes(String(entry.disposition).trim().toLowerCase()) && !/^[0-9a-fA-F]{40}$/.test(entry.fixingCommitSha.trim())) {
      throw new Error(`Fixer disposition handoff entry for thread ${threadId} needs fixingCommitSha as the full 40-character SHA (git rev-parse <commit>)`);
    }
    if (!isNonEmptyString(entry.disposition)) {
      throw new Error(`Fixer disposition handoff entry for thread ${threadId} is missing disposition`);
    }
    const fingerprint = isNonEmptyString(entry.fingerprint) ? entry.fingerprint.trim() : null;
    const disposition = entry.disposition.trim().toLowerCase();
    if (!Object.values(FIXER_DISPOSITION_KIND).includes(disposition)) {
      throw new Error(`Fixer disposition handoff entry for thread ${threadId} has an unrecognized disposition: ${disposition}`);
    }
    if (entry.replyNote !== undefined && !isNonEmptyString(entry.replyNote)) throw new Error(`Fixer disposition handoff entry for thread ${threadId} replyNote must be a non-empty string`);
    if (disposition === FIXER_DISPOSITION_KIND.PARTIALLY_FIXED && entry.replyNote === undefined) throw new Error(`Fixer disposition handoff entry for thread ${threadId} is partially_fixed and needs a replyNote naming what is not done`);
    return {
      threadId,
      fingerprint,
      fixingCommitSha: entry.fixingCommitSha.trim(),
      disposition,
      validation: isNonEmptyString(entry.validation) ? entry.validation.trim() : null,
      ...(entry.replyNote !== undefined ? { replyNote: cleanReplyNote(entry.replyNote, `Fixer disposition handoff entry for thread ${threadId} replyNote`) } : {}),
      ...normalizeSiteCoverage(entry, `Fixer disposition handoff entry for thread ${threadId}`, ruleIds),
    };
  });
  const siteCoverage = normalizeSiteCoverageRecords(raw.siteCoverage, ruleIds);
  return {
    headSha: raw.headSha.trim(),
    dispositions,
    ...(siteCoverage.length > 0 ? { siteCoverage } : {}),
  };
}

function formatIncompleteReason(incomplete) {
  const parts = incomplete.map((entry) => (
    `${entry.reviewId ? `review ${entry.reviewId}` : `thread ${entry.threadId}`} (expected commit ${entry.expectedCommit ?? "unknown"}, failed step: ${entry.failedStep})`
  ));
  const shortSha = incomplete.some((entry) => entry.failedStep === FIXER_DISPOSITION_FAILED_STEP.RESOLVED_SHORT_SHA_REPLY)
    ? " A resolved thread whose replies cite only a short SHA needs the full 40-character SHA: run `dev-loops-run scripts/github/unresolve-review-thread.mjs --repo <owner/name> --pr <n> --thread-id <thread id>`, then re-run the verifier, which replies with the full SHA and resolves again."
    : "";
  const noteReply = incomplete.some((entry) => entry.failedStep === FIXER_DISPOSITION_FAILED_STEP.RESOLVED_NOTE_REPLY_MISSING)
    ? " A resolved thread with a replyNote and no composed reply needs that reply: unresolve it (the same unresolve-review-thread.mjs command), then re-run the verifier, which posts the reply and resolves again."
    : "";
  return `Fixer disposition is incomplete for ${incomplete.length} entry(ies): ${parts.join("; ")}. `
    + `The only legal next action is ${COMPLETE_FIXER_DISPOSITION_ACTION}.${shortSha}${noteReply}`;
}

// A short hex token in a reply that is a prefix of the fixing commit.
const citesShortSha = (body, commit) => (String(body).toLowerCase().match(/\b[0-9a-f]{7,39}\b/g) ?? []).some((token) => commit.toLowerCase().startsWith(token));

/**
 * PURE evaluator: given a normalized handoff, the live thread state, and an
 * injected commit-containment fact table, decide whether every thread the
 * fixer claims to have tackled is fully disposed (commit contained, replied
 * with that commit's evidence, and resolved). No I/O — every fact the
 * decision needs is a plain argument, which is what keeps this seam shared
 * verbatim across harnesses.
 *
 * @param {object} params
 * @param {{ headSha: string, dispositions: Array<object> }} params.handoff - raw or already-normalized; ALWAYS re-validated via normalizeFixerDispositionHandoff (idempotent on already-normalized input), so a malformed array-bearing handoff can never bypass schema+enum validation just by already carrying an array
 * @param {Array<{ threadId: string, isResolved: boolean, replyBodies?: string[], claimedTackled?: boolean }>} [params.liveThreads]
 * @param {Record<string, boolean>} [params.containment] - fixingCommitSha -> true when the observed PR head contains it
 * @param {Record<string, boolean>} [params.fixAfterReview] - per fixing commit, whether it is strictly after the reviewed commit (false refuses a review-body entry)
 * @param {Array<{ reviewId: string, markerCommits: string[] }>} [params.liveReviews] - per review-body entry, the fixing commits that trusted marker comments cite
 * @returns {{ ok: boolean, incomplete: Array<{ threadId: string, expectedCommit: string|null, failedStep: string } | { reviewId: string, expectedCommit: string|null, failedStep: string }>, forbiddenActions: string[], nextAction: string|null, reason: string|null }}
 */
export function evaluateFixerDisposition({ handoff, liveThreads = [], containment = {}, liveReviews = [], fixAfterReview = {} } = {}) {
  const normalizedHandoff = normalizeFixerDispositionHandoff(handoff ?? {});
  const threadEntries = normalizedHandoff.dispositions.filter((entry) => entry.threadId);
  const handoffByThreadId = new Map(threadEntries.map((entry) => [entry.threadId, entry]));
  const liveByThreadId = new Map(
    (Array.isArray(liveThreads) ? liveThreads : [])
      .filter((entry) => entry && typeof entry.threadId === "string")
      .map((entry) => [entry.threadId, entry]),
  );

  // The must-check set: every handoff entry explicitly marked "tackled", plus
  // any live thread independently flagged claimedTackled (e.g. a fixer's own
  // claim the CLI cross-referenced against live GitHub state) that has no
  // handoff counterpart at all — that gap is exactly missing_from_handoff.
  const tackledThreadIds = new Set();
  for (const entry of threadEntries) {
    if (FIXER_COMMIT_CLAIM_KINDS.includes(entry.disposition)) {
      tackledThreadIds.add(entry.threadId);
    }
  }
  for (const liveThread of liveByThreadId.values()) {
    if (liveThread.claimedTackled === true) {
      tackledThreadIds.add(liveThread.threadId);
    }
  }

  const incomplete = [];
  for (const threadId of tackledThreadIds) {
    const handoffEntry = handoffByThreadId.get(threadId) ?? null;
    if (!handoffEntry) {
      incomplete.push({ threadId, expectedCommit: null, failedStep: FIXER_DISPOSITION_FAILED_STEP.MISSING_FROM_HANDOFF });
      continue;
    }
    const expectedCommit = handoffEntry.fixingCommitSha;
    // Non-goal enforcement: a SHA alone is never evidence. Only an injected
    // containment[sha] === true (the observed PR head provably contains the
    // commit) can authorize the reply/resolve steps below.
    if (containment?.[expectedCommit] !== true) {
      incomplete.push({ threadId, expectedCommit, failedStep: FIXER_DISPOSITION_FAILED_STEP.COMMIT_NOT_CONTAINED });
      continue;
    }
    const liveThread = liveByThreadId.get(threadId) ?? null;
    const replyBodies = Array.isArray(liveThread?.replyBodies) ? liveThread.replyBodies : [];
    // A noted entry needs its own composed reply: an unrelated earlier reply citing the SHA does not satisfy it.
    const composedBody = handoffEntry.replyNote ? composeFixerReplyBody(handoffEntry) : null;
    const hasEvidencedReply = composedBody ? replyBodies.includes(composedBody) : replyBodies.some((body) => (
      typeof body === "string" && body.toLowerCase().includes(expectedCommit.toLowerCase())
    ));
    if (!hasEvidencedReply) {
      // A resolved thread cannot take the verifier's reply: name the short-SHA cause so the remedy is runnable.
      const shortOnly = liveThread?.isResolved === true && replyBodies.some((body) => citesShortSha(body, expectedCommit));
      // A resolved thread with a noted entry cannot take the composed reply either: name the unresolve remedy.
      const failedStep = composedBody && liveThread?.isResolved === true ? FIXER_DISPOSITION_FAILED_STEP.RESOLVED_NOTE_REPLY_MISSING
        : shortOnly ? FIXER_DISPOSITION_FAILED_STEP.RESOLVED_SHORT_SHA_REPLY : FIXER_DISPOSITION_FAILED_STEP.REPLY_MISSING;
      incomplete.push({ threadId, expectedCommit, failedStep });
      continue;
    }
    if (liveThread?.isResolved !== true) {
      incomplete.push({ threadId, expectedCommit, failedStep: FIXER_DISPOSITION_FAILED_STEP.NOT_RESOLVED });
    }
  }

  // A deferred or rejected entry with a replyNote needs its own composed reply and a resolved thread; no commit is claimed.
  for (const entry of threadEntries.filter((e) => !FIXER_COMMIT_CLAIM_KINDS.includes(e.disposition) && e.replyNote)) {
    const liveThread = liveByThreadId.get(entry.threadId) ?? null;
    const body = composeFixerReplyBody(entry);
    const failedStep = !(liveThread?.replyBodies ?? []).includes(body)
      ? (liveThread?.isResolved === true ? FIXER_DISPOSITION_FAILED_STEP.RESOLVED_NOTE_REPLY_MISSING : FIXER_DISPOSITION_FAILED_STEP.REPLY_MISSING)
      : liveThread?.isResolved !== true ? FIXER_DISPOSITION_FAILED_STEP.NOT_RESOLVED : null;
    if (failedStep) incomplete.push({ threadId: entry.threadId, expectedCommit: null, failedStep });
  }

  // A review body has no thread: its evidence is a trusted marker comment citing the fixing commit (`liveReviews[].markerCommits`).
  const markersByReview = new Map((Array.isArray(liveReviews) ? liveReviews : []).map((review) => [review?.reviewId, review?.markerCommits ?? []]));
  for (const entry of normalizedHandoff.dispositions.filter((e) => e.reviewId && e.disposition === FIXER_DISPOSITION_KIND.TACKLED)) {
    const { reviewId, fixingCommitSha: expectedCommit } = entry;
    const failedStep = containment?.[expectedCommit] !== true ? FIXER_DISPOSITION_FAILED_STEP.COMMIT_NOT_CONTAINED
      : fixAfterReview?.[expectedCommit] === false ? FIXER_DISPOSITION_FAILED_STEP.FIX_NOT_AFTER_REVIEW
      : !(markersByReview.get(reviewId) ?? []).some((commit) => String(commit).toLowerCase() === expectedCommit.toLowerCase()) ? FIXER_DISPOSITION_FAILED_STEP.REPLY_MISSING : null;
    if (failedStep) incomplete.push({ reviewId, expectedCommit, failedStep });
  }

  const ok = incomplete.length === 0;
  return {
    ok,
    incomplete,
    forbiddenActions: ok ? [] : [...FIXER_DISPOSITION_FORBIDDEN_ACTIONS],
    nextAction: ok ? null : COMPLETE_FIXER_DISPOSITION_ACTION,
    reason: ok ? null : formatIncompleteReason(incomplete),
  };
}

const OPERATOR_FOCUS_REF = "operator-focus";
const FULL_SHA_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** The judge's authorized remediation and its site query ride each act item, so the fixer edits against the remedy text. */
export const REMEDIATION_TEXT_FIELDS = Object.freeze(["authorizedRemediation", "defectClass", "siteQuery", "defectKind"]);
export const REMEDIATION_LIST_FIELDS = Object.freeze(["acceptedForms", "rejectedForms", "statedSurfaces"]);

/**
 * Maps a `capture-review-threads --unresolved --bodies` payload onto the `list-review-threads --unresolved-only`
 * shape the thread route validates; any other payload passes through unchanged.
 * A capture holds trusted unresolved threads only, so those markers are implied.
 * A capture not bound to the target (an input or stdin source, another repo or PR) maps to a refused payload.
 * @param {unknown} payload
 * @param {{ repo: string, pr: number|string }} target
 */
export function normalizeThreadsPayload(payload, { repo, pr } = {}) {
  const p = /** @type {any} */ (payload);
  if (!p || typeof p.source !== "object" || p.source === null || p.repo !== undefined || !Array.isArray(p.threads) || !p.threads.every((thread) => Array.isArray(thread?.bodies) && thread.bodies.length > 0 && thread.bodies.every((b) => typeof b === "string"))) return payload;
  const bound = p.ok === true && p.source.type === "github" && p.source.repo === repo && Number(p.source.pr) === Number(pr);
  return { ...p, ok: bound, repo, pr, threads: p.threads.map((thread) => ({ ...thread, isResolved: false, trusted: true, body: thread.bodies.join("\n\n") })) };
}

/** The act items an operator focus contributes when the thread source holds no thread: its `round` text. */
export function operatorFocusActItems(operatorFocus) {
  const summary = typeof operatorFocus?.round === "string" ? operatorFocus.round.trim() : "";
  return summary ? [{ ref: OPERATOR_FOCUS_REF, angle: OPERATOR_FOCUS_REF, summary, judgeDisposition: "act" }] : [];
}

/**
 * Reduce a judge act list (the `judge-pass --out` array) to the neutral act
 * items the reviewer may see. Only allow-listed fields pass, so reviewer
 * verdicts, "clean" claims and diff bytes never reach the act item.
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
    const ledgerRef = [entry.ref, entry.fingerprint].find(isNonEmptyString);
    const item = {
      ref: ledgerRef ? ledgerRef.trim() : `act-${index + 1}`,
      angle: isNonEmptyString(entry.angle) ? entry.angle.trim() : null,
      severity: normalizeSeverity(entry.severity) ?? null,
      summary: isNonEmptyString(entry.summary) ? entry.summary.trim() : "",
      judgeDisposition: "act",
    };
    if (isNonEmptyString(entry.judgeRationale)) item.judgeRationale = entry.judgeRationale.trim();
    // The site coverage record keys on the ledger fingerprint, which a repeated-fingerprint ref suffix would hide.
    if (isNonEmptyString(entry.fingerprint)) item.fingerprint = entry.fingerprint.trim();
    for (const key of REMEDIATION_TEXT_FIELDS) if (isNonEmptyString(entry[key])) item[key] = entry[key].trim();
    for (const key of REMEDIATION_LIST_FIELDS) if (Array.isArray(entry[key]) && entry[key].length > 0) item[key] = key === "statedSurfaces" ? entry[key].filter(isNonEmptyString).map((v) => v.trim()) : entry[key].filter((v) => typeof v === "string"); // a form is an input (verbatim), a surface is a location (trimmed)
    if (Array.isArray(entry.siblingRemediations) && entry.siblingRemediations.length > 0) item.siblingRemediations = entry.siblingRemediations;
    if (isNonEmptyString(entry.file)) item.file = entry.file.trim();
    if (Number.isInteger(entry.line)) item.line = entry.line;
    return item;
  });
  // A fingerprint hashes only file and summary, so entries from different clusters
  // can share one; suffix the repeats deterministically. Explicit refs stay unique.
  const refs = new Set();
  const fingerprintCounts = new Map();
  items.forEach((item, index) => {
    const entry = actList[index];
    if (!isNonEmptyString(entry.ref) && isNonEmptyString(entry.fingerprint)) {
      const count = (fingerprintCounts.get(item.ref) ?? 0) + 1;
      fingerprintCounts.set(item.ref, count);
      if (count > 1) item.ref = `${item.ref}#${count}`;
    }
    if (refs.has(item.ref)) throw new Error(`act list has duplicate ref ${JSON.stringify(item.ref)}`);
    refs.add(item.ref);
  });
  return items;
}

/** A PR-body item names no file or carries `remedyKind: "pr_body"` (never a review-thread or operator-focus item); a thread item is exempt (its ref is the thread id). */
export const isDeltaBodyItem = (entry) => entry?.angle !== "review-thread" && entry?.angle !== OPERATOR_FOCUS_REF && (entry?.remedyKind === "pr_body" || !resolveFindingFile(entry));

export const convergedActItemKey = (item) => `${normalizeSeverity(item?.severity)}|${String(item?.summary).trim()}`;

// An allowlist: a missing, blank or unknown severity blocks.
export const isBlockedActItem = (item) => !["medium", "low", "nit"].includes(String(normalizeSeverity(item?.severity)).toLowerCase()) || item?.failOpen === true || isSecurityAngle(item?.angle);
// A security angle is `security`, a prefixed one (`renderer-security`) and any of them with a `-delta-at-<sha>` suffix.
// shortcut: no shared security classification exists in core; a pr-gate-coordination one would replace this.
function isSecurityAngle(angle) { return /(^|-)security(-|$)/.test(baseAngleName(String(angle ?? ""))); }

/**
 * Body-only round (ADR 0271 as amended by ADR 0332, GATE-EXEC-NO-DEAD-END): a draft_gate round at any round, below the cap or at it, whose open act items are all PR-body items clears with no commit.
 * Hard checks cover narrow facts only: every item is a PR-body item (no file, or remedyKind pr_body), the live PR body digest differs from the
 * reviewed `pr-body` read, the reviewed head..fixerCommit range holds no PR-own commit, and no item blocks (high, question, fail-open, security, missing or unknown severity).
 * Whether the edit resolves an item stays with pre_approval_gate. `fixerCommit` may equal the reviewed head.
 * Throws a typed refusal (`body_item_locatable`, `body_unchanged`, `own_commit_in_range`, `body_read_unrecorded`, `blocked_item`); returns the converged marker.
 * @param {{ gate?: string, headSha?: string, round?: number, cap?: number, roundActItems?: any[], converged?: { fixerCommit?: string, actList?: any[] }, reviewedBodySha?: string|null, liveBodySha?: string, ownCommits?: number }} input
 * @returns {{ fixerCommit: string, deltaDigest: string }}
 */
export function composeBodyOnlyConvergedDraftGate({ gate, headSha, round, cap, roundActItems, roundFindings, converged, reviewedBodySha, liveBodySha, ownCommits } = {}) {
  if (gate !== "draft_gate") throw new Error(`body-only converged verdict applies to draft_gate only, got ${JSON.stringify(gate)}`);
  if (!FULL_SHA_RE.test(headSha ?? "") || !FULL_SHA_RE.test(converged?.fixerCommit ?? "")) throw new Error("body-only converged verdict requires the full reviewed head sha and fixerCommit");
  const items = roundActItems ?? [];
  const keys = (list) => JSON.stringify(list.map(convergedActItemKey).sort());
  if (items.length === 0 || !Array.isArray(converged?.actList) || keys(converged.actList) !== keys(items)) throw new Error("converged.actList must be the round's non-empty act list (same items as the posted act items)");
  if (converged?.deltaResult !== undefined) throw new Error("body-only converged verdict takes no converged.deltaResult; a body-only post carries the act list only");
  // The cap-round blocking set (deferred high, fail-open, missing disposition, severity disagreement) holds for the whole round, not only its act items.
  const capBlockers = pastCapBlockers(roundFindings ?? items, { round, cap });
  if (capBlockers.length > 0) throw new Error(`blocked_item: the round holds ${capBlockers.length} blocker(s) (${capBlockers.map((b) => b.item).join("; ")}); they need a fix commit or an operator decision, not a body-only exit`);
  const blocked = items.find(isBlockedActItem);
  if (blocked) throw new Error(`blocked_item: act item ${JSON.stringify(blocked.summary)} is not medium, low or nit, is fail-open or is from a security angle; it needs a fix commit or an operator decision, not a body-only exit (GATE-EXEC-NO-DEAD-END)`);
  const locatable = items.find((item) => !isDeltaBodyItem(item));
  if (locatable) throw new Error(locatable.angle === "review-thread"
    ? `body_item_locatable: act item ${JSON.stringify(locatable.summary)} is a review-thread item; a thread is never a PR-body item, so it needs a fix commit and the next draft_gate round, not a body-only exit`
    : `body_item_locatable: act item ${JSON.stringify(locatable.summary)} names a file and is not remedyKind pr_body; it needs a fix commit and the next draft_gate round, not a body-only exit`);
  if (!reviewedBodySha) {
    throw new Error(`body_read_unrecorded: no round context records a pr-body read at ${headSha}, so a body edit cannot be shown, and write-gate-context.mjs refuses a rerun at that head; fix the items with a commit and push it; the next draft_gate round runs at the new head`);
  }
  if (reviewedBodySha === liveBodySha) throw new Error("body_unchanged: the live PR body digest equals the reviewed pr-body read; edit the PR body first");
  if (ownCommits !== 0) throw new Error(`own_commit_in_range: ${headSha}..${converged.fixerCommit} holds ${ownCommits} PR-own commit(s); a fix commit needs the next draft_gate round at the pushed head, not a body-only exit`);
  return { fixerCommit: converged.fixerCommit, deltaDigest: sha256Hex({ bodyOnly: true, reviewedBodySha, liveBodySha, actList: converged.actList }) };
}
