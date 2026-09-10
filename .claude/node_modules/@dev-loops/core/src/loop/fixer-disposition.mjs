// GATE-EXEC-FIXER-DISPOSITION-BOUNDARY (skills/docs/gate-review-sub-loop-contract.md):
// fail closed when a fixer push leaves the review threads it claims to have
// tackled incomplete (missing evidence, uncontained commit, unreplied, or
// unresolved). This module is a PURE evaluator — every GitHub/git fact
// (live thread state, commit containment) is injected as data, never fetched
// here, so the same decision is shared verbatim across every harness.

/** Disposition values a handoff entry may carry. Only "tackled" entries are
 * auto-disposed by evaluateFixerDisposition; every other value keeps its
 * existing judgment path untouched (see the boundary rule's scope note). */
export const FIXER_DISPOSITION_KIND = Object.freeze({
  TACKLED: "tackled",
  DEFERRED: "deferred",
  REJECTED: "rejected",
});

export const FIXER_DISPOSITION_FAILED_STEP = Object.freeze({
  MISSING_FROM_HANDOFF: "missing_from_handoff",
  COMMIT_NOT_CONTAINED: "commit_not_contained",
  REPLY_MISSING: "reply_missing",
  NOT_RESOLVED: "not_resolved",
});

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

/**
 * Validate + normalize a raw fixer-disposition handoff. Throws on any
 * structural gap the evaluator must never silently tolerate: a missing
 * headSha, a non-array dispositions field, a missing
 * threadId/fixingCommitSha/disposition on any entry, an unrecognized
 * disposition value, or a duplicate threadId/fingerprint across entries.
 *
 * @param {object} raw
 * @returns {{ headSha: string, dispositions: Array<{ threadId: string, fingerprint: string|null, fixingCommitSha: string, disposition: string, validation: string|null }> }}
 */
export function normalizeFixerDispositionHandoff(raw) {
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
  const seenFingerprints = new Set();
  const dispositions = rawDispositions.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Fixer disposition handoff entry ${index} must be an object`);
    }
    if (!isNonEmptyString(entry.threadId)) {
      throw new Error(`Fixer disposition handoff entry ${index} is missing threadId`);
    }
    const threadId = entry.threadId.trim();
    if (seenThreadIds.has(threadId)) {
      throw new Error(`Fixer disposition handoff has a duplicate threadId: ${threadId}`);
    }
    seenThreadIds.add(threadId);
    if (!isNonEmptyString(entry.fixingCommitSha)) {
      throw new Error(`Fixer disposition handoff entry for thread ${threadId} is missing fixingCommitSha`);
    }
    if (!isNonEmptyString(entry.disposition)) {
      throw new Error(`Fixer disposition handoff entry for thread ${threadId} is missing disposition`);
    }
    const fingerprint = isNonEmptyString(entry.fingerprint) ? entry.fingerprint.trim() : null;
    if (fingerprint !== null) {
      if (seenFingerprints.has(fingerprint)) {
        throw new Error(`Fixer disposition handoff has a duplicate fingerprint: ${fingerprint}`);
      }
      seenFingerprints.add(fingerprint);
    }
    const disposition = entry.disposition.trim().toLowerCase();
    if (!Object.values(FIXER_DISPOSITION_KIND).includes(disposition)) {
      throw new Error(`Fixer disposition handoff entry for thread ${threadId} has an unrecognized disposition: ${disposition}`);
    }
    return {
      threadId,
      fingerprint,
      fixingCommitSha: entry.fixingCommitSha.trim(),
      disposition,
      validation: isNonEmptyString(entry.validation) ? entry.validation.trim() : null,
    };
  });
  return {
    headSha: raw.headSha.trim(),
    dispositions,
  };
}

function formatIncompleteReason(incomplete) {
  const parts = incomplete.map((entry) => (
    `thread ${entry.threadId} (expected commit ${entry.expectedCommit ?? "unknown"}, failed step: ${entry.failedStep})`
  ));
  return `Fixer disposition is incomplete for ${incomplete.length} tackled thread(s): ${parts.join("; ")}. `
    + `The only legal next action is ${COMPLETE_FIXER_DISPOSITION_ACTION}.`;
}

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
 * @returns {{ ok: boolean, incomplete: Array<{ threadId: string, expectedCommit: string|null, failedStep: string }>, forbiddenActions: string[], nextAction: string|null, reason: string|null }}
 */
export function evaluateFixerDisposition({ handoff, liveThreads = [], containment = {} } = {}) {
  const normalizedHandoff = normalizeFixerDispositionHandoff(handoff ?? {});
  const handoffByThreadId = new Map(normalizedHandoff.dispositions.map((entry) => [entry.threadId, entry]));
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
  for (const entry of normalizedHandoff.dispositions) {
    if (entry.disposition === FIXER_DISPOSITION_KIND.TACKLED) {
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
    const hasEvidencedReply = replyBodies.some((body) => (
      typeof body === "string" && body.toLowerCase().includes(expectedCommit.toLowerCase())
    ));
    if (!hasEvidencedReply) {
      incomplete.push({ threadId, expectedCommit, failedStep: FIXER_DISPOSITION_FAILED_STEP.REPLY_MISSING });
      continue;
    }
    if (liveThread?.isResolved !== true) {
      incomplete.push({ threadId, expectedCommit, failedStep: FIXER_DISPOSITION_FAILED_STEP.NOT_RESOLVED });
    }
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
