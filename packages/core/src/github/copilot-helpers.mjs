/**
 * Shared deterministic helpers for Copilot-related GitHub data.
 *
 * These are pure functions with no filesystem or network dependencies.
 * Owner: packages/core — reusable deterministic logic consumed by both
 * scripts and other packages/core modules.
 */

// Exported so anything deciding "is there a real prior review" uses the same
// whitelist as the loop-state reader — two copies could drift, and a guard
// acting on the gate's behalf must agree with the gate about what a submitted
// review is.
export const SUBMITTED_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]);
const GATE_REVIEW_NAMES = new Set(["draft_gate", "pre_approval_gate"]);
const GATE_REVIEW_VERDICTS = new Set(["clean", "findings_present", "blocked"]);
const GATE_EXECUTION_MODES = new Set(["fanout_fanin", "inline_single_agent"]);

// The literal header line the gate review body always emits first
// (upsert-checkpoint-verdict.mjs's renderGateReviewCommentBody, re-exported
// from there). Owned here so the machine-artifact filter below and every
// consumer that needs to recognize "is this a real gate verdict surface" read
// the same producer-owned literal instead of restating it. Line-start anchored
// (`m`) so a quoted header in a reply/blockquote can't match.
export const GATE_REVIEW_COMMENT_HEADER_RE = /^###\s+Gate review:\s*`(draft_gate|pre_approval_gate)`\s*$/m;

/** Returns the matched gate name when `body` carries a genuine gate verdict header, else null. */
export function matchGateReviewCommentHeader(body) {
  if (typeof body !== "string") return null;
  const match = body.match(GATE_REVIEW_COMMENT_HEADER_RE);
  return match ? match[1] : null;
}

// Machine-authored gate artifacts that must never win the newest-gate-marker
// tie-break in summarizeGateReviewComments/summarizeGateReviewCommentMarkers:
// a historical standalone findings review always embedded this gate's name in
// its header line and could quote the current head sha inside a finding's own
// free text (the lenient gate-name+hex-token fallback in
// parseGateReviewCommentFields would otherwise happily match that), and the
// historical deferred-summary PR comment quoted a gate name plus a sha-shaped
// id in its table rows the same way. Both are excluded HERE, inside the two
// shared summarizers, because this module is the true merge point: every
// consumer (detect-checkpoint-evidence.mjs, pre-pr-ready-gate.mjs,
// ready-for-review.mjs, request-copilot-review.mjs) calls
// summarizeGateReviewComments/summarizeGateReviewCommentMarkers to turn a raw
// comment/review list into a gate verdict, so filtering here — rather than
// per-caller — covers all of them by construction.
//
// Anchored to the start of a line (`^` with `m`) so only a marker rendered as
// the first character of its own line is excluded — a genuine verdict
// comment whose findings summary merely QUOTES the marker text mid-line (for
// example, describing this very mechanism) still counts as evidence. Both
// producers render their marker at column 0, so the anchor costs nothing
// against genuine artifacts.
// The set covers exactly three marker tokens: the per-round review round
// marker (gate-findings-review), post-gate-findings.mjs's opt-in findings
// COMMENT marker (gate-findings gate=...), and the historical
// deferred-summary comment. Without the findings-comment marker, that comment
// parses as a verdict marker candidate (its "Gate fan-out findings:"/
// "Reviewed head:" lines yield gate+headSha) and the verdict upsert claims
// and overwrites it in place, silently destroying the round's visible
// findings record. Every branch is delimiter-anchored — the token must be
// followed by whitespace or the closing `-->` — so no suffixed `<token>-<x>`
// variant ever matches.
const GATE_MACHINE_ARTIFACT_MARKER_RE = /^<!--\s*dev-loops:(?:gate-findings-review|gate-findings|deferred-summary)(?=\s|-->)/mu;

export function isGateMachineArtifactBody(body) {
  if (typeof body !== "string" || !GATE_MACHINE_ARTIFACT_MARKER_RE.test(body)) {
    return false;
  }
  // A gate round now posts ONE PR review carrying BOTH the verdict header and
  // the gate-findings-review marker (the findings it files live on that same
  // surface). Such a body IS the verdict, not a separate machine artifact, so
  // the producer-owned verdict header wins over the artifact marker. Only a
  // marker-bearing body with NO genuine verdict header (a historical standalone
  // findings review or deferred-summary comment) stays excluded.
  return matchGateReviewCommentHeader(body) === null;
}

export function isCopilotLogin(login) {
  return typeof login === "string" && /^copilot(?:[^a-z]|$)/i.test(login);
}

// Anti-summon literal: bare-text `@copilot` or a `/copilot*` slash command. Both
// the write-side sanitizer and the read-side guard scan key off this shape so a
// gate-evidence comment can quote the rule (inside a code span/fenced block)
// without arming the request-copilot-review.mjs anti-summon guard. The token
// regex carries the same left word-boundary as the guard regex so the sanitizer
// never mangles text the guard would not arm on (e.g. user@copilot.example).
const COPILOT_SUMMON_TOKEN_RE = /(?<=^|\W)(@copilot|\/copilot[a-z0-9_-]*)/gi;
const COPILOT_SUMMON_WORD_BOUNDARY_RE = /(?:^|\W)(@copilot|\/copilot)(?:$|\W)/i;
// GFM inline code span: an N-backtick run, lazy content, closed by a same-length
// run. Covers single-backtick spans as well as double-backtick spans wrapping a
// literal backtick.
const INLINE_CODE_SPAN_RE = /(`+)[\s\S]*?\1(?!`)/g;
const ZERO_WIDTH_JOINER = "\u200D";

// Apply `transformLine` to every markdown line OUTSIDE a fenced code block
// (```/~~~), leaving fence-delimiter lines and fenced content untouched.
// Mirrors the fenced-block tracking scripts/docs/validate-rule-ownership.mjs
// uses for its own lexical scan.
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
// primary neutralization (visible, greppable), but pre-existing backticks on the
// line can destabilize it two ways: an UNBALANCED stray backtick pairs with an
// inserted one and re-exposes the token to the guard's span-stripping, and
// adjacent spans (e.g. a span ending right before the token's new wrap) can make
// the wrapped line re-tokenize differently on the next pass, re-wrapping the
// token and growing the comment by one backtick per rewrite. The wrapped result
// is therefore accepted only when it is BOTH guard-inert AND a fixed point of
// the wrapper (re-wrapping it changes nothing); otherwise fall back to inserting
// a zero-width joiner into the residual tokens still outside the wrapped line's
// spans — invisible, guard-inert, and idempotent (the joined token no longer
// matches the summon shape). Working on the wrapped line (not the original)
// preserves every stable backtick wrap and keeps the joiner out of legitimate
// pre-existing code spans.
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

// Drop all markdown code content (fenced blocks entirely, inline code spans
// per line) from `text`, leaving only the bare-text markdown to scan. Unlike
// transformNonFencedLines (which leaves fenced lines verbatim — correct for
// sanitizing, where code content must not be rewritten), fenced content here
// must be REMOVED rather than kept: leaving it in place would let bare text
// inside a fence still match the anti-summon scan.
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

    // First-NON-EMPTY-wins per field: a genuine comment renders its structured
    // block first, so the first column-0 match for each field is normally the
    // real one. A free-text field (findings summary, next action) rendered
    // later in the SAME comment can embed a newline plus a spoofed
    // "Verdict: clean" (or any other field label) at column 0; capturing only
    // the first match (rather than the last) stops that later line from
    // winning and flipping/nulling the field. But the label regex's
    // `\s*(.+)$` also matches a label followed by nothing but whitespace,
    // capturing an empty string — for the enum fields (gate/headSha/verdict/
    // executionMode) an empty capture normalizes to null already, so the
    // `=== null` guard below naturally stays open for a later, genuine line.
    // The two free-text fields (findingsSummary, nextAction) do NOT normalize
    // through an enum, so an empty capture must be checked for explicitly:
    // treat it as no-capture (leave the field open) rather than locking it to
    // "" and hiding a real line that renders after it.
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
        // An empty capture (label followed only by whitespace) is treated as
        // no-capture: leave the field open so a later, genuine line can still
        // win instead of first-wins locking it to "".
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
        // Only record an inline reason for inline_single_agent. A trailing
        // "— text" on a fanout_fanin (or invalid) mode line must not surface an
        // inconsistent mode/reason pair, so leave inlineReason null otherwise.
        if (reasonToken.length > 0 && fields.executionMode === "inline_single_agent") {
          fields.inlineReason = reasonToken;
        }
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

// Which GitHub surface carries a gate verdict. The poster needs it to pick the
// right in-place correction endpoint on a same-head rerun (a PR review is PUT
// to pulls/{pr}/reviews/{id}; a legacy verdict issue comment is PATCHed to
// issues/comments/{id}). Anything that is not the review surface — including a
// raw issue-comment payload with no `surface` field — is issue_comment, so the
// historical shape survives untouched. SINGLE definition: a restatement that
// misses a future third surface would silently route its body to the
// issue-comment endpoint, where it does not live.
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
      surface: normalizeVerdictSurface(comment?.surface),
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
      contractComplete: parsed.contractComplete,
      surface: normalizeVerdictSurface(comment?.surface),
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

/**
 * Resolve the draft-gate round-reset timestamp (ms) used to suppress stale Copilot
 * review rounds from the count (#896 consistency).
 *
 * When the draft gate was re-passed clean on a DIFFERENT head than the current one,
 * only Copilot reviews submitted after that re-pass should count toward the round
 * cap. Returning the re-pass `updatedAt` (ms) lets {@link summarizeCopilotReviews}
 * drop earlier rounds. Returns null when no reset applies (no clean draft gate, or
 * the clean draft gate is already on the current head).
 *
 * Both detect-pr-gate-coordination-state and request-copilot-review must derive the
 * reset identically, or the two scripts disagree on the completed round count and
 * the cap (the inconsistency reported in #896). This is the single shared source.
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
