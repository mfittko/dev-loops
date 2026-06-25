/**
 * Shared deterministic helpers for Copilot-related GitHub data.
 *
 * These are pure functions with no filesystem or network dependencies.
 * Owner: packages/core — reusable deterministic logic consumed by both
 * scripts and other packages/core modules.
 */

const SUBMITTED_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]);
const GATE_REVIEW_NAMES = new Set(["draft_gate", "pre_approval_gate"]);
const GATE_REVIEW_VERDICTS = new Set(["clean", "findings_present", "blocked"]);
const GATE_EXECUTION_MODES = new Set(["fanout_fanin", "inline_single_agent"]);

export function isCopilotLogin(login) {
  return typeof login === "string" && /^copilot(?:[^a-z]|$)/i.test(login);
}

export function normalizeTimestamp(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function extractReviewCommitSha(review) {
  const graphqlSha = typeof review?.commit?.oid === "string" ? review.commit.oid.trim() : "";
  const restSha = typeof review?.commit_id === "string" ? review.commit_id.trim() : "";
  const sha = graphqlSha || restSha;
  return sha.length > 0 ? sha : null;
}

function stripOptionalCodeTicks(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.startsWith("`") && trimmed.endsWith("`") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function stripGateCommentMarkdown(rawLine) {
  let line = rawLine.trim();
  if (line.length === 0) {
    return "";
  }
  line = line.replace(/^#{1,6}\s+/u, "");
  line = line.replace(/\*\*/gu, "");
  return line.trim();
}

function normalizeGateReviewName(value) {
  const normalized = stripOptionalCodeTicks(value).toLowerCase();
  return GATE_REVIEW_NAMES.has(normalized) ? normalized : null;
}

function normalizeGateReviewVerdict(value) {
  const normalized = stripOptionalCodeTicks(value).toLowerCase();
  return GATE_REVIEW_VERDICTS.has(normalized) ? normalized : null;
}

function normalizeGateReviewHeadSha(value) {
  const normalized = stripOptionalCodeTicks(value).toLowerCase();
  return /^[0-9a-f]{7,64}$/i.test(normalized) ? normalized : null;
}

function normalizeGateExecutionMode(value) {
  const normalized = stripOptionalCodeTicks(value).toLowerCase();
  return GATE_EXECUTION_MODES.has(normalized) ? normalized : null;
}

function parseGateReviewCommentFields(body) {
  if (typeof body !== "string" || body.trim().length === 0) {
    return null;
  }

  const fields = {
    gate: null,
    headSha: null,
    verdict: null,
    findingsSummary: null,
    nextAction: null,
    executionMode: null,
    inlineReason: null,
  };

  for (const rawLine of body.split(/\r?\n/u)) {
    const stripped = stripGateCommentMarkdown(rawLine);
    if (stripped.length === 0) {
      continue;
    }
    const line = stripped;

    let match = line.match(/^(?:[-*]\s*)?(?:gate(?:\s+name)?|gate\s+review)\s*:\s*(.+)$/iu);
    if (match) {
      fields.gate = normalizeGateReviewName(match[1]);
      continue;
    }

    match = line.match(/^(?:[-*]\s*)?(?:head\s+sha(?:\s+reviewed)?|reviewed\s+head\s+sha)\s*:\s*(.+)$/iu);
    if (match) {
      fields.headSha = normalizeGateReviewHeadSha(match[1]);
      continue;
    }

    match = line.match(/^(?:[-*]\s*)?verdict\s*:\s*(.+)$/iu);
    if (match) {
      fields.verdict = normalizeGateReviewVerdict(match[1]);
      continue;
    }

    match = line.match(/^(?:[-*]\s*)?(?:findings(?:\s+summary)?|summary)\s*:\s*(.+)$/iu);
    if (match) {
      fields.findingsSummary = match[1].trim();
      continue;
    }

    match = line.match(/^(?:[-*]\s*)?next\s+action\s*:\s*(.+)$/iu);
    if (match) {
      fields.nextAction = match[1].trim();
      continue;
    }

    match = line.match(/^(?:[-*]\s*)?execution\s+mode\s*:\s*(.+)$/iu);
    if (match) {
      const rest = match[1].trim();
      // Split on the first em-dash / en-dash / " - " separator to recover an
      // optional inline reason: "inline_single_agent — <reason>".
      const sepMatch = rest.match(/^(.*?)\s*(?:[—–]|\s-\s)\s*(.*)$/u);
      const modeToken = sepMatch ? sepMatch[1].trim() : rest;
      const reasonToken = sepMatch ? sepMatch[2].trim() : "";
      fields.executionMode = normalizeGateExecutionMode(modeToken);
      if (reasonToken.length > 0) {
        fields.inlineReason = reasonToken;
      }
      continue;
    }
  }

  // Lenient fallback: detect gate name and head SHA anywhere in body
  // Handles comments posted via other tools without structured field format
  if (!fields.gate || !fields.headSha) {
    const flatBody = body.replace(/\*\*/gu, "").replace(/`/gu, "");

    if (!fields.gate) {
      const canonicalGateNames = [...GATE_REVIEW_NAMES].join("|");
      const gateMatch = flatBody.match(
        new RegExp(`\\b(${canonicalGateNames})\\b`, "iu")
      );
      if (gateMatch) {
        fields.gate = normalizeGateReviewName(gateMatch[1]);
      }
    }

    if (!fields.headSha) {
      // Prefer SHA following a "head" context marker to avoid false
      // matches on plain-text numeric IDs (issue/comment IDs, etc.)
      // Example: "pre_approval_gate for head e284c2e341" or "commit abc1234def"
      const ctxShaMatch = flatBody.match(
        /\b(?:head|sha|commit)\b\s*(?:sha)?\s*[:=]?\s*`?\b([0-9a-f]{7,64})\b`?/iu
      );
      if (ctxShaMatch) {
        fields.headSha = normalizeGateReviewHeadSha(ctxShaMatch[1]);
      } else {
        // Fallback: any hex token, strip known URL/id noise first
        const cleanBody = flatBody.replace(
          /https:\/\/github\.com\/[^\s]+#issuecomment-\d+/g, ""
        );
        const shaMatch = cleanBody.match(/\b([0-9a-f]{7,64})\b/iu);
        if (shaMatch) {
          fields.headSha = normalizeGateReviewHeadSha(shaMatch[1]);
        }
      }
    }
  }

  if (!fields.gate || !fields.headSha) {
    return null;
  }

  return fields;
}

export function parseGateReviewCommentBody(body) {
  const parsed = parseGateReviewCommentFields(body);
  if (!parsed || !parsed.verdict || !parsed.findingsSummary || !parsed.nextAction) {
    return null;
  }
  return parsed;
}

export function parseGateReviewCommentMarkerBody(body) {
  const fields = parseGateReviewCommentFields(body);
  if (!fields || !fields.gate || !fields.headSha) {
    return null;
  }

  return {
    gate: fields.gate,
    headSha: fields.headSha,
    verdict: fields.verdict,
    findingsSummary: fields.findingsSummary,
    nextAction: fields.nextAction,
    executionMode: fields.executionMode,
    inlineReason: fields.inlineReason,
    contractComplete: Boolean(fields.verdict && fields.findingsSummary && fields.nextAction),
  };
}

export function summarizeGateReviewComments(comments) {
  const summary = {
    draft_gate: null,
    pre_approval_gate: null,
  };

  const entries = Array.isArray(comments) ? comments : [];

  for (let index = 0; index < entries.length; index += 1) {
    const comment = entries[index];
    const parsed = parseGateReviewCommentBody(comment?.body);
    if (!parsed) {
      continue;
    }

    const updatedAtMs = normalizeTimestamp(comment?.updated_at ?? comment?.updatedAt ?? comment?.created_at ?? comment?.createdAt);
    const candidate = {
      visible: true,
      gate: parsed.gate,
      headSha: parsed.headSha,
      verdict: parsed.verdict,
      findingsSummary: parsed.findingsSummary,
      nextAction: parsed.nextAction,
      commentId: Number.isInteger(comment?.id) ? comment.id : null,
      commentUrl: typeof comment?.html_url === "string" && comment.html_url.trim().length > 0 ? comment.html_url.trim() : null,
      updatedAt: typeof (comment?.updated_at ?? comment?.updatedAt) === "string"
        ? (comment.updated_at ?? comment.updatedAt).trim()
        : typeof (comment?.created_at ?? comment?.createdAt) === "string"
          ? (comment.created_at ?? comment.createdAt).trim()
          : null,
      updatedAtMs,
      arrayIndex: index,
    };

    const current = summary[parsed.gate];
    if (!current || (candidate.updatedAtMs ?? -1) > (current.updatedAtMs ?? -1) || ((candidate.updatedAtMs ?? -1) === (current.updatedAtMs ?? -1) && candidate.arrayIndex > current.arrayIndex)) {
      summary[parsed.gate] = candidate;
    }
  }

  return summary;
}

export function summarizeGateReviewCommentMarkers(comments, { headSha } = {}) {
  const summary = {
    draft_gate: null,
    pre_approval_gate: null,
  };

  const entries = Array.isArray(comments) ? comments : [];
  const normalizedHeadSha = normalizeGateReviewHeadSha(headSha);

  for (let index = 0; index < entries.length; index += 1) {
    const comment = entries[index];
    const parsed = parseGateReviewCommentMarkerBody(comment?.body);
    if (!parsed) {
      continue;
    }

    if (normalizedHeadSha && parsed.headSha !== normalizedHeadSha) {
      continue;
    }

    const updatedAtMs = normalizeTimestamp(comment?.updated_at ?? comment?.updatedAt ?? comment?.created_at ?? comment?.createdAt);
    const candidate = {
      visible: true,
      gate: parsed.gate,
      headSha: parsed.headSha,
      verdict: parsed.verdict,
      findingsSummary: parsed.findingsSummary,
      nextAction: parsed.nextAction,
      executionMode: parsed.executionMode ?? null,
      inlineReason: parsed.inlineReason ?? null,
      contractComplete: parsed.contractComplete,
      commentId: Number.isInteger(comment?.id) ? comment.id : null,
      commentUrl: typeof comment?.html_url === "string" && comment.html_url.trim().length > 0 ? comment.html_url.trim() : null,
      updatedAt: typeof (comment?.updated_at ?? comment?.updatedAt) === "string"
        ? (comment.updated_at ?? comment.updatedAt).trim()
        : typeof (comment?.created_at ?? comment?.createdAt) === "string"
          ? (comment.created_at ?? comment.createdAt).trim()
          : null,
      updatedAtMs,
      arrayIndex: index,
    };

    const current = summary[parsed.gate];
    if (!current || (candidate.updatedAtMs ?? -1) > (current.updatedAtMs ?? -1) || ((candidate.updatedAtMs ?? -1) === (current.updatedAtMs ?? -1) && candidate.arrayIndex > current.arrayIndex)) {
      summary[parsed.gate] = candidate;
    }
  }

  return summary;
}

export function summarizeCopilotReviews(reviews, { headSha, draftGateResetAtMs } = {}) {
  const allReviews = Array.isArray(reviews) ? reviews : [];
  const copilotReviews = allReviews.filter((review) => isCopilotLogin(review?.author?.login));

  // When draft gate has re-passed on a different head, only count reviews
  // after the most recent draft gate approval to prevent round accumulation.
  const effectiveReviews = draftGateResetAtMs != null && draftGateResetAtMs > 0
    ? copilotReviews.filter((review) => {
        const state = typeof review?.state === "string" ? review.state.toUpperCase() : "";
        const reviewCommitSha = extractReviewCommitSha(review);
        const reviewOnCurrentHead = headSha !== null && reviewCommitSha === headSha;
        // Always retain PENDING reviews on the current head so
        // hasPendingReviewOnCurrentHead stays accurate even when
        // submittedAt is null (common for PENDING GitHub reviews).
        if (state === "PENDING" && reviewOnCurrentHead) {
          return true;
        }
        const submittedAtMs = normalizeTimestamp(review?.submittedAt ?? review?.submitted_at);
        return submittedAtMs !== null && submittedAtMs > draftGateResetAtMs;
      })
    : copilotReviews;

  let hasPendingReviewOnCurrentHead = false;
  let hasSubmittedReviewOnCurrentHead = false;
  let latestSubmittedReviewOnCurrentHeadAt = null;
  let completedCopilotReviewRounds = 0;

  for (const review of effectiveReviews) {
    const state = typeof review?.state === "string" ? review.state.toUpperCase() : "";
    const reviewCommitSha = extractReviewCommitSha(review);
    const reviewOnCurrentHead = headSha !== null && reviewCommitSha === headSha;

    if (SUBMITTED_REVIEW_STATES.has(state)) {
      completedCopilotReviewRounds += 1;
    }

    if (!reviewOnCurrentHead) {
      continue;
    }

    if (state === "PENDING") {
      hasPendingReviewOnCurrentHead = true;
      continue;
    }

    if (SUBMITTED_REVIEW_STATES.has(state)) {
      hasSubmittedReviewOnCurrentHead = true;
      const submittedAt = typeof review?.submittedAt === "string" ? review.submittedAt : null;
      if (submittedAt !== null && (latestSubmittedReviewOnCurrentHeadAt === null || submittedAt > latestSubmittedReviewOnCurrentHeadAt)) {
        latestSubmittedReviewOnCurrentHeadAt = submittedAt;
      }
    }
  }

  return {
    copilotReviews,
    copilotReviewIds: copilotReviews
      .map((review) => review?.id)
      .filter((id) => id !== null && id !== undefined)
      .map((id) => String(id)),
    copilotReviewPresent: copilotReviews.length > 0,
    completedCopilotReviewRounds,
    hasPendingReviewOnCurrentHead,
    hasSubmittedReviewOnCurrentHead,
    latestSubmittedReviewOnCurrentHeadAt,
  };
}
