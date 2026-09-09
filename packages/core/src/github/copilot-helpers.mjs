/**
 * Shared deterministic helpers for Copilot-related GitHub data.
 * Pure functions with no filesystem or network dependencies.
 */

import { GATE_REVIEW_VERDICT_SET } from "../loop/policy-constants.mjs";
import { trimmedOrNull } from "../loop/normalize.mjs";

// Same whitelist as the loop-state reader: two copies could drift, and a guard
// acting on the gate's behalf must agree with the gate about what a submitted
// review is.
export const SUBMITTED_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]);

// Copilot's COMMENTED review summary opens with a disposition header:
// "### 🟡 Changes recommended" (findings) or "### 🟢 Approval recommended"
// (clean). The 🟡 marker / "changes recommended" phrase is the finding signal;
// an explicit approval/clean signal (🟢, "approval recommended", or a negated
// "no ... changes recommended" — including markdown emphasis between the words)
// overrides a bare phrase mention so a clean body is never a false finding. A
// 🟡 marker is authoritative and is never overridden. A CHANGES_REQUESTED
// review always carries a finding regardless of body (fail toward surfacing on
// an ambiguous non-empty body). APPROVED/DISMISSED never do.
const COPILOT_CHANGES_RECOMMENDED_RE = /🟡|changes\s+recommended/iu;
const COPILOT_APPROVAL_MARKER_RE = /🟢|approval\s+recommended|\bno\b[^\n]*\bchanges\s+recommended/iu;

export function copilotReviewBodySignalsChanges(state, body) {
  const normalizedState = typeof state === "string" ? state.toUpperCase() : "";
  if (normalizedState === "CHANGES_REQUESTED") return true;
  if (normalizedState !== "COMMENTED") return false;
  const text = typeof body === "string" ? body : "";
  if (!COPILOT_CHANGES_RECOMMENDED_RE.test(text)) return false;
  // A 🟡 marker is authoritative; otherwise an explicit approval/negation signal
  // (🟢, "approval recommended", "No changes recommended") reads clean.
  if (!/🟡/u.test(text) && COPILOT_APPROVAL_MARKER_RE.test(text)) return false;
  return true;
}
const GATE_REVIEW_NAMES = new Set(["draft_gate", "pre_approval_gate"]);
// `review` is a RECOGNIZED gate header that carries no draft/pre-approval
// evidence by design. Recognizing it lets
// parseGateReviewCommentFields short-circuit to null on a `review` header
// instead of falling through to the lenient draft_gate/pre_approval_gate token
// scan — the fallthrough that would otherwise record a `review` verdict whose
// findings merely mention "draft_gate" as real draft-gate evidence (a
// draft-gate bypass).
const NON_EVIDENCE_GATE_NAMES = new Set(["review"]);
const RECOGNIZED_GATE_NAMES = new Set([...GATE_REVIEW_NAMES, ...NON_EVIDENCE_GATE_NAMES]);
const GATE_EXECUTION_MODES = new Set(["fanout_fanin", "inline_single_agent"]);
// Size-budget outcome vocabulary; mirrors check-size-budget.mjs's
// computeSizeBudget outcome enum exactly. This file only round-trips it.
const GATE_SIZE_OUTCOMES = new Set(["pass", "escalate", "block"]);

// The literal header line the gate review body emits first (producer:
// upsert-checkpoint-verdict.mjs's renderGateReviewCommentBody). Owned here so
// every consumer reads the same literal instead of restating it. Line-start
// anchored (`m`) so a quoted header in a reply/blockquote can't match.
export const GATE_REVIEW_COMMENT_HEADER_RE = /^###\s+Gate review:\s*`(draft_gate|pre_approval_gate)`\s*$/m;

/** Returns the matched gate name when `body` carries a genuine gate verdict header, else null. */
export function matchGateReviewCommentHeader(body) {
  if (typeof body !== "string") return null;
  const match = body.match(GATE_REVIEW_COMMENT_HEADER_RE);
  return match ? match[1] : null;
}

// Machine-authored gate artifacts that must never win the newest-gate-marker
// tie-break in the two summarizers below: a historical standalone findings
// review or deferred-summary comment embeds a gate name and a sha-shaped id
// that the lenient parseGateReviewCommentFields fallback would otherwise match.
// Excluded here because this module is the merge point every consumer routes
// through.
//
// Line-anchored (`^` with `m`) so only a marker at column 0 is excluded; a
// genuine verdict whose findings merely QUOTE the marker mid-line still counts.
// The set covers exactly three tokens: the per-round review marker
// (gate-findings-review), post-gate-findings.mjs's findings-COMMENT marker
// (gate-findings), and the deferred-summary comment. Without the
// findings-comment marker, that comment parses as a verdict candidate and the
// verdict upsert overwrites it in place, silently destroying the round's
// findings record. Every branch is delimiter-anchored (token followed by
// whitespace or `-->`) so no suffixed `<token>-<x>` variant matches.
const GATE_MACHINE_ARTIFACT_MARKER_RE = /^<!--\s*dev-loops:(?:gate-findings-review|gate-findings|deferred-summary)(?=\s|-->)/mu;

export function isGateMachineArtifactBody(body) {
  if (typeof body !== "string" || !GATE_MACHINE_ARTIFACT_MARKER_RE.test(body)) {
    return false;
  }
  // A gate round posts ONE PR review carrying BOTH the verdict header and the
  // gate-findings-review marker. Such a body IS the verdict, so the
  // producer-owned header wins over the artifact marker. Only a marker-bearing
  // body with NO verdict header stays excluded.
  return matchGateReviewCommentHeader(body) === null;
}

export function isCopilotLogin(login) {
  return typeof login === "string" && /^copilot(?:[^a-z]|$)/i.test(login);
}

/**
 * Resolve whether Copilot is present as a reviewer on a PR from the REVIEW
 * surface only — requested reviewers plus submitted reviews — never from
 * assignees. Assignment is a disjoint surface: on a reviewer-configured
 * repo Copilot is never an assignee, so an assignee-based proxy would falsely
 * report a configured Copilot reviewer as absent and let the gate skip the
 * Copilot-convergence requirement on a false premise.
 *
 * @param {object} params
 * @param {boolean} [params.requested] - Copilot is listed in the PR's requested_reviewers
 * @param {Array<{author?: {login?: string}}>} [params.reviews] - PR review list
 * @returns {{ present: boolean, sources: string[] }}
 */
export function resolveCopilotReviewPresence({ requested = false, reviews = [] } = {}) {
  const list = Array.isArray(reviews) ? reviews : [];
  const sources = [];
  if (requested === true) {
    sources.push("requested_reviewer");
  }
  if (list.some((review) => isCopilotLogin(review?.author?.login))) {
    sources.push("submitted_review");
  }
  return { present: sources.length > 0, sources };
}

// Anti-summon literal: bare-text `@copilot` or a `/copilot*` slash command.
// Both the write-side sanitizer and the read-side guard key off this shape so a
// gate-evidence comment can quote the rule (in a code span/fence) without arming
// the request-copilot-review.mjs anti-summon guard. The token regex carries the
// same left word-boundary as the guard regex so the sanitizer never mangles text
// the guard would not arm on (e.g. user@copilot.example).
const COPILOT_SUMMON_TOKEN_RE = /(?<=^|\W)(@copilot|\/copilot[a-z0-9_-]*)/gi;
const COPILOT_SUMMON_WORD_BOUNDARY_RE = /(?:^|\W)(@copilot|\/copilot)(?:$|\W)/i;
// GFM inline code span: an N-backtick run, lazy content, closed by a same-length
// run. Covers single-backtick spans as well as double-backtick spans wrapping a
// literal backtick.
const INLINE_CODE_SPAN_RE = /(`+)[\s\S]*?\1(?!`)/g;
const ZERO_WIDTH_JOINER = "\u200D";

// Apply `transformLine` to every markdown line OUTSIDE a fenced code block
// (```/~~~), leaving fence-delimiter lines and fenced content untouched.
function transformNonFencedLines(text, transformLine) {
  const lines = String(text).split(/\r?\n/);
  let inFencedBlock = false;
  let fencedDelimiter = "";
  const transformed = lines.map((line) => {
    const rawTrimmed = line.trim();
    const fenceMatch = rawTrimmed.match(/^(```|~~~)/);
    if (fenceMatch) {
      if (!inFencedBlock) {
        inFencedBlock = true;
        fencedDelimiter = fenceMatch[1];
        return line;
      }
      if (rawTrimmed.startsWith(fencedDelimiter)) {
        inFencedBlock = false;
        fencedDelimiter = "";
        return line;
      }
    }
    if (inFencedBlock) {
      return line;
    }
    return transformLine(line);
  });
  return transformed.join("\n");
}

// Apply `replaceSegment` to every part of a line that lies OUTSIDE an inline
// code span (any N-backtick GFM span), leaving span content untouched.
function transformOutsideSpans(line, replaceSegment) {
  let result = "";
  let last = 0;
  for (const span of line.matchAll(INLINE_CODE_SPAN_RE)) {
    result += replaceSegment(line.slice(last, span.index));
    result += span[0];
    last = span.index + span[0].length;
  }
  return result + replaceSegment(line.slice(last));
}

// Wrap bare `@copilot`/`/copilot*` tokens in backticks so a comment can quote the
// anti-summon rule without arming it. Tokens already inside an inline code span
// are left untouched.
function wrapBareSummonTokensInLine(line) {
  return transformOutsideSpans(line, (segment) => segment.replace(COPILOT_SUMMON_TOKEN_RE, "`$1`"));
}

// Does this single (non-fenced) line still arm the guard scan after inline code
// spans are dropped? Mirrors stripMarkdownCodeForScan's per-line step. Spans are
// replaced with a SPACE, not the empty string: the fragments flanking a span
// must never be rejoined into a token that was not present ("@copi`x`lot" is not
// a summon), while a token directly abutting a span ("text`x`@copilot", which
// GitHub renders as a real mention) still arms.
function lineArmsSummonGuard(line) {
  return COPILOT_SUMMON_WORD_BOUNDARY_RE.test(line.replace(INLINE_CODE_SPAN_RE, " "));
}

const ZWJ_FALLBACK_RE = /(?<=^|\W)([@/])(copilot)/gi;

// Sanitize one line, verifying against the guard scan. Backtick-wrapping is the
// primary neutralization (visible, greppable), but pre-existing backticks can
// destabilize it: an unbalanced stray backtick re-exposes the token to the
// guard's span-stripping, and adjacent spans can make the wrapped line
// re-tokenize on the next pass and grow by a backtick per rewrite. So the
// wrapped result is accepted only when it is BOTH guard-inert AND a fixed point
// of the wrapper; otherwise fall back to a zero-width joiner in the residual
// tokens outside the wrapped line's spans — invisible, guard-inert, and
// idempotent. Working on the wrapped line preserves stable wraps and keeps the
// joiner out of legitimate pre-existing code spans.
function sanitizeSummonLine(line) {
  const wrapped = wrapBareSummonTokensInLine(line);
  if (!lineArmsSummonGuard(wrapped) && wrapBareSummonTokensInLine(wrapped) === wrapped) {
    return wrapped;
  }
  return transformOutsideSpans(wrapped, (segment) => segment.replace(ZWJ_FALLBACK_RE, `$1${ZERO_WIDTH_JOINER}$2`));
}

export function sanitizeCopilotSummonTokens(text) {
  return transformNonFencedLines(String(text), sanitizeSummonLine);
}

// Drop all markdown code content (fenced blocks entirely, inline spans per
// line) from `text`, leaving only bare-text markdown to scan. Unlike
// transformNonFencedLines, fenced content here must be REMOVED, not kept:
// leaving it would let bare text inside a fence still match the summon scan.
function stripMarkdownCodeForScan(text) {
  const lines = String(text).split(/\r?\n/);
  let inFencedBlock = false;
  let fencedDelimiter = "";
  const kept = [];
  for (const line of lines) {
    const rawTrimmed = line.trim();
    const fenceMatch = rawTrimmed.match(/^(```|~~~)/);
    if (fenceMatch) {
      if (!inFencedBlock) {
        inFencedBlock = true;
        fencedDelimiter = fenceMatch[1];
      } else if (rawTrimmed.startsWith(fencedDelimiter)) {
        inFencedBlock = false;
        fencedDelimiter = "";
      }
      continue;
    }
    if (inFencedBlock) {
      continue;
    }
    // Space (not empty-string) replacement: see lineArmsSummonGuard.
    kept.push(line.replace(INLINE_CODE_SPAN_RE, " "));
  }
  return kept.join("\n");
}

// The request-copilot-review.mjs anti-summon guard scan: true when `text`
// contains a bare-text (not code-spanned/fenced) `@copilot` or `/copilot`
// occurrence. Quoting the rule inside backticks or a fenced block is exempt.
export function containsBareCopilotSummon(text) {
  return COPILOT_SUMMON_WORD_BOUNDARY_RE.test(stripMarkdownCodeForScan(text));
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

// Recognizes BOTH evidence gates and the non-evidence `review` gate:
// parseGateReviewCommentFields relies on `review` coming back identified (not
// null) so it can short-circuit rather than fall through to the lenient
// token-scan fallback.
function normalizeGateReviewName(value) {
  const normalized = stripOptionalCodeTicks(value).toLowerCase();
  return RECOGNIZED_GATE_NAMES.has(normalized) ? normalized : null;
}

function normalizeGateReviewVerdict(value) {
  const normalized = stripOptionalCodeTicks(value).toLowerCase();
  return GATE_REVIEW_VERDICT_SET.has(normalized) ? normalized : null;
}

function normalizeGateReviewHeadSha(value) {
  const normalized = stripOptionalCodeTicks(value).toLowerCase();
  return /^[0-9a-f]{7,64}$/i.test(normalized) ? normalized : null;
}

function normalizeGateExecutionMode(value) {
  const normalized = stripOptionalCodeTicks(value).toLowerCase();
  return GATE_EXECUTION_MODES.has(normalized) ? normalized : null;
}

function normalizeGateSizeOutcome(value) {
  const normalized = stripOptionalCodeTicks(value).toLowerCase();
  return GATE_SIZE_OUTCOMES.has(normalized) ? normalized : null;
}

function normalizeGateSizeTouchesT1(value) {
  const normalized = stripOptionalCodeTicks(value).toLowerCase();
  if (normalized === "touched") return true;
  if (normalized === "not touched") return false;
  return null;
}

// "none" | "granted" | "granted by <name>" — the approver name is free text
// (already sanitized by the poster via sanitizeInline before rendering), so
// no further normalization beyond trimming is applied here.
function normalizeGateSizeWaiver(value) {
  const normalized = stripOptionalCodeTicks(value).trim();
  if (/^none$/iu.test(normalized)) return { granted: false, approvedBy: null };
  const grantedMatch = normalized.match(/^granted(?:\s+by\s+(.+))?$/iu);
  if (grantedMatch) {
    const approvedBy = grantedMatch[1]?.trim();
    return { granted: true, approvedBy: approvedBy && approvedBy.length > 0 ? approvedBy : null };
  }
  return null;
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
    sizeOutcome: null,
    sizeTouchesT1: null,
    sizeWaiverGranted: null,
    sizeWaiverApprovedBy: null,
  };

  for (const rawLine of body.split(/\r?\n/u)) {
    const stripped = stripGateCommentMarkdown(rawLine);
    if (stripped.length === 0) {
      continue;
    }
    const line = stripped;

    // First-NON-EMPTY-wins per field: the first column-0 match is the genuine
    // structured block. A later free-text field (findings, next action) can
    // embed a spoofed "Verdict: clean" at column 0; capturing only the first
    // match stops that from flipping the field. Enum fields normalize an empty
    // capture (label + whitespace only) to null, so their `=== null` guard
    // stays open for a later genuine line; the two free-text fields do NOT, so
    // an empty capture is checked explicitly and treated as no-capture.
    let match = line.match(/^(?:[-*]\s*)?(?:gate(?:\s+name)?|gate\s+review)\s*:\s*(.+)$/iu);
    if (match) {
      if (fields.gate === null) {
        fields.gate = normalizeGateReviewName(match[1]);
      }
      continue;
    }

    match = line.match(/^(?:[-*]\s*)?(?:head\s+sha(?:\s+reviewed)?|reviewed\s+head\s+sha)\s*:\s*(.+)$/iu);
    if (match) {
      if (fields.headSha === null) {
        fields.headSha = normalizeGateReviewHeadSha(match[1]);
      }
      continue;
    }

    match = line.match(/^(?:[-*]\s*)?verdict\s*:\s*(.+)$/iu);
    if (match) {
      if (fields.verdict === null) {
        fields.verdict = normalizeGateReviewVerdict(match[1]);
      }
      continue;
    }

    match = line.match(/^(?:[-*]\s*)?(?:findings(?:\s+summary)?|summary)\s*:\s*(.+)$/iu);
    if (match) {
      if (fields.findingsSummary === null) {
        const candidate = match[1].trim();
        // Empty capture treated as no-capture (see first-non-empty-wins above).
        if (candidate.length > 0) {
          fields.findingsSummary = candidate;
        }
      }
      continue;
    }

    match = line.match(/^(?:[-*]\s*)?next\s+action\s*:\s*(.+)$/iu);
    if (match) {
      if (fields.nextAction === null) {
        const candidate = match[1].trim();
        if (candidate.length > 0) {
          fields.nextAction = candidate;
        }
      }
      continue;
    }

    match = line.match(/^(?:[-*]\s*)?execution\s+mode\s*:\s*(.+)$/iu);
    if (match) {
      if (fields.executionMode === null) {
        const rest = match[1].trim();
        // Split on the first em-dash / en-dash / " - " separator to recover an
        // optional inline reason: "inline_single_agent — <reason>".
        const sepMatch = rest.match(/^(.*?)\s*(?:[—–]|\s-\s)\s*(.*)$/u);
        const modeToken = sepMatch ? sepMatch[1].trim() : rest;
        const reasonToken = sepMatch ? sepMatch[2].trim() : "";
        fields.executionMode = normalizeGateExecutionMode(modeToken);
        // Only record an inline reason for inline_single_agent; a trailing
        // "— text" on any other mode must not surface an inconsistent pair.
        if (reasonToken.length > 0 && fields.executionMode === "inline_single_agent") {
          fields.inlineReason = reasonToken;
        }
      }
      continue;
    }

    match = line.match(/^(?:[-*]\s*)?size[\s-]budget\s+outcome\s*:\s*(.+)$/iu);
    if (match) {
      if (fields.sizeOutcome === null) {
        fields.sizeOutcome = normalizeGateSizeOutcome(match[1]);
      }
      continue;
    }

    match = line.match(/^(?:[-*]\s*)?size[\s-]budget\s+t1\s+slice\s*:\s*(.+)$/iu);
    if (match) {
      if (fields.sizeTouchesT1 === null) {
        fields.sizeTouchesT1 = normalizeGateSizeTouchesT1(match[1]);
      }
      continue;
    }

    match = line.match(/^(?:[-*]\s*)?size[\s-]budget\s+waiver\s*:\s*(.+)$/iu);
    if (match) {
      if (fields.sizeWaiverGranted === null) {
        const parsedWaiver = normalizeGateSizeWaiver(match[1]);
        if (parsedWaiver) {
          fields.sizeWaiverGranted = parsedWaiver.granted;
          fields.sizeWaiverApprovedBy = parsedWaiver.approvedBy;
        }
      }
      continue;
    }
  }

  // A recognized `review` gate is authoritative and returns null before the
  // lenient token-scan fallback runs: a `review` verdict carries no
  // draft/pre-approval evidence by design. An identified
  // non-evidence gate must never be treated as an unidentified body, which is
  // the only case the token-scan fallback exists for.
  if (NON_EVIDENCE_GATE_NAMES.has(fields.gate)) {
    return null;
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
      // Prefer SHA following a "head" context marker to avoid false matches on
      // plain-text numeric IDs (issue/comment IDs, etc.).
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
    sizeOutcome: fields.sizeOutcome,
    sizeTouchesT1: fields.sizeTouchesT1,
    sizeWaiverGranted: fields.sizeWaiverGranted,
    sizeWaiverApprovedBy: fields.sizeWaiverApprovedBy,
    contractComplete: Boolean(fields.verdict && fields.findingsSummary && fields.nextAction),
  };
}

// Which GitHub surface carries a gate verdict; the poster uses it to pick the
// in-place correction endpoint on a same-head rerun (review → PUT
// pulls/{pr}/reviews/{id}; issue comment → PATCH issues/comments/{id}).
// Anything not the review surface (including a payload with no `surface` field)
// is issue_comment. SINGLE definition: a restatement missing a future third
// surface would misroute its body to the issue-comment endpoint.
export function normalizeVerdictSurface(value) {
  return value === "review" ? "review" : "issue_comment";
}

export function summarizeGateReviewComments(comments) {
  const summary = {
    draft_gate: null,
    pre_approval_gate: null,
  };

  const entries = Array.isArray(comments) ? comments : [];

  for (let index = 0; index < entries.length; index += 1) {
    const comment = entries[index];
    if (isGateMachineArtifactBody(comment?.body)) {
      continue;
    }
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
      executionMode: parsed.executionMode ?? null,
      inlineReason: parsed.inlineReason ?? null,
      sizeOutcome: parsed.sizeOutcome ?? null,
      sizeTouchesT1: parsed.sizeTouchesT1 ?? null,
      sizeWaiverGranted: parsed.sizeWaiverGranted ?? null,
      sizeWaiverApprovedBy: parsed.sizeWaiverApprovedBy ?? null,
      surface: normalizeVerdictSurface(comment?.surface),
      commentId: Number.isInteger(comment?.id) ? comment.id : null,
      commentUrl: trimmedOrNull(comment?.html_url),
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
    if (isGateMachineArtifactBody(comment?.body)) {
      continue;
    }
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
      sizeOutcome: parsed.sizeOutcome ?? null,
      sizeTouchesT1: parsed.sizeTouchesT1 ?? null,
      sizeWaiverGranted: parsed.sizeWaiverGranted ?? null,
      sizeWaiverApprovedBy: parsed.sizeWaiverApprovedBy ?? null,
      contractComplete: parsed.contractComplete,
      surface: normalizeVerdictSurface(comment?.surface),
      commentId: Number.isInteger(comment?.id) ? comment.id : null,
      commentUrl: trimmedOrNull(comment?.html_url),
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

/**
 * Resolve the draft-gate round-reset timestamp (ms) used to suppress stale
 * Copilot review rounds from the count. When the draft gate re-passed
 * clean on a DIFFERENT head, only Copilot reviews after that re-pass count
 * toward the round cap; returning the re-pass `updatedAt` (ms) lets
 * summarizeCopilotReviews drop earlier rounds. Null when no reset applies.
 * Single shared source: detect-pr-gate-coordination-state and
 * request-copilot-review must derive the reset identically.
 *
 * @param {object} params
 * @param {{ verdict?: string|null, headSha?: string|null, updatedAt?: string|null }|null} params.draftGate
 * @param {string|null} params.currentHeadSha
 * @returns {number|null} reset timestamp in ms, or null
 */
export function resolveDraftGateRoundResetMs({ draftGate, currentHeadSha } = {}) {
  const draftGateHeadSha = typeof draftGate?.headSha === "string" ? draftGate.headSha : null;
  const draftGateOnCurrentHead = typeof draftGateHeadSha === "string"
    && typeof currentHeadSha === "string"
    && currentHeadSha.startsWith(draftGateHeadSha);
  if (draftGate?.verdict === "clean"
    && typeof draftGateHeadSha === "string"
    && !draftGateOnCurrentHead
    && typeof draftGate?.updatedAt === "string") {
    return normalizeTimestamp(draftGate.updatedAt);
  }
  return null;
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
  let hasBodyFindingOnCurrentHead = false;
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
      const submittedAt = typeof review?.submittedAt === "string"
        ? review.submittedAt
        : (typeof review?.submitted_at === "string" ? review.submitted_at : null);
      if (submittedAt !== null && (latestSubmittedReviewOnCurrentHeadAt === null || submittedAt > latestSubmittedReviewOnCurrentHeadAt)) {
        latestSubmittedReviewOnCurrentHeadAt = submittedAt;
        hasBodyFindingOnCurrentHead = copilotReviewBodySignalsChanges(state, review?.body);
      } else if (submittedAt !== null && submittedAt === latestSubmittedReviewOnCurrentHeadAt) {
        // Equal-timestamp tie on the same head: fail toward surfacing so array
        // order never silently drops a finding when two reviews share a timestamp.
        hasBodyFindingOnCurrentHead = hasBodyFindingOnCurrentHead || copilotReviewBodySignalsChanges(state, review?.body);
      } else if (submittedAt === null && latestSubmittedReviewOnCurrentHeadAt === null) {
        hasBodyFindingOnCurrentHead = hasBodyFindingOnCurrentHead || copilotReviewBodySignalsChanges(state, review?.body);
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
    hasBodyFindingOnCurrentHead,
  };
}
