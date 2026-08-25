/**
 * Shared gate finding-surface primitives.
 *
 * A gate round has exactly ONE visible surface: the PR review
 * upsert-checkpoint-verdict.mjs posts (verdict-marker body + inline finding
 * comments). This module owns everything both that poster and the
 * close-gate-findings.mjs disposition pass need to agree on — fingerprints,
 * finding/review markers, the in-diff position walk, the ledger read, and the
 * round number — so the two can never drift apart on a shape they both parse.
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { matchGateReviewCommentHeader } from "@dev-loops/core/github/copilot-helpers";
import { createIssue as coreCreateIssue, commentIssue as coreCommentIssue } from "@dev-loops/core/github/issue-ops";
import { VALID_SEVERITIES, hasLocatableShape, normalizeSeverity } from "@dev-loops/core/loop/gate-fanin";
import { runChild as defaultRunChild } from "../_cli-primitives.mjs";
import {
  parseJsonText,
  sanitizeCopilotSummonTokens,
  summarizeGateReviewCommentMarkers,
  summarizeGateReviewComments,
} from "../_core-helpers.mjs";
import { normalizeFullHeadSha } from "../lib/head-sha.mjs";
import { flattenPaginatedSlurp, listIssueComments, resolveAuthenticatedLogin, runGhJson, sanitizeCodeSpan, sanitizeInline } from "./post-gate-findings.mjs";
import { buildLogPath } from "./write-gate-findings-log.mjs";
import { BODY_EXCERPT_MAX_CHARS, fetchAllReviewThreads } from "./list-review-threads.mjs";
import { captureParsedReviewThreads } from "./_review-thread-mutations.mjs";
import { guardCommentBodyNoIssuePrIds } from "@dev-loops/core/github/comment-id-guard";

// Canonical filter/map for a paginated GET pulls/{pr}/reviews payload into the
// comment-stream shape the gate summarizers consume. Validity comes from the
// shared isSubmittedReview predicate below — two restatements of that
// expression drifted once already; never inline it again.
// The one predicate for "counts as a submitted review with content": every
// consumer (verdict evidence, round resolution, fingerprint suppression) MUST
// share this function, never restate the expression.
function isSubmittedReview(r) {
  return Boolean(r) && typeof r === "object" && r.state !== "PENDING"
    && typeof r.submitted_at === "string" && r.submitted_at.trim().length > 0
    && typeof r.body === "string" && r.body.trim().length > 0;
}

export function normalizePrReviewsPayload(payload) {
  return flattenPaginatedSlurp(payload)
    .filter(isSubmittedReview)
    .map((r) => ({
      id: r.id,
      body: r.body,
      // The gate round's single visible surface is a PR review, so the poster
      // needs to know a verdict came from here (PUT pulls/reviews/{id}) rather
      // than from the legacy issue-comment stream (PATCH issues/comments/{id}).
      surface: "review",
      html_url: typeof r.html_url === "string" ? r.html_url : null,
      created_at: r.submitted_at,
      updated_at: r.submitted_at,
    }));
}

const VALID_LEDGER_VERDICTS = new Set(["clean", "findings_present", "blocked"]);
const VALID_GATES = new Set(["draft_gate", "pre_approval_gate"]);

// Findings at round <= this stay in the standard fix loop; from the next round
// on, an open medium finding is deferred instead of re-fixed in-gate.
export const MEDIUM_FIX_WINDOW = 3;

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

// Slug a marker field value down to a safe, single-token spelling. Severity and
// angle are controlled vocabulary in practice, but the marker format itself
// must never break (a stray space would split it into unparseable garbage and
// could, worst case, let free text masquerade as marker fields), so this is
// belt-and-suspenders normalization, not display formatting. Also length-capped
// (belt-and-braces): an angle label long enough to push the whole marker past
// list-review-threads.mjs's 200-char listing excerpt would make the marker
// itself unparseable there, silently hiding the thread from disposition and
// from the unresolved-thread gate check.
const MARKER_FIELD_MAX_CHARS = 40;

function slugForMarker(value) {
  const slug = String(value).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const bounded = slug.length > MARKER_FIELD_MAX_CHARS ? slug.slice(0, MARKER_FIELD_MAX_CHARS) : slug;
  return bounded.length > 0 ? bounded : "unknown";
}

// True when a finding at `severity`, reconciled against the CURRENT round, is
// disposed as deferred: high never defers; medium defers only once the chain
// is past the in-gate fix window; low always defers immediately; question
// never defers (it is answered, not deferred — an unanswered question blocks
// gate-close as an unresolved thread, exactly like an open defect); nit always
// defers immediately, with no fixer cycle. An unrecognized severity fails
// CLOSED (false, never auto-deferred): a malformed/forged marker must surface
// as a dangling gate-authored thread that blocks gate-close, never get
// silently stamped `disposition=deferred` and resolved through the same path
// as a genuine low/nit finding. Governs the THREAD disposition pass
// ONLY — a locatable finding's round-gated fix window, decided through its own
// resolvable review thread. Body-filed finding rendering
// (renderNonLocatableBlock) deliberately does NOT call this: a body-filed
// finding never gets a thread to fix through, so it is stamped deferred
// unconditionally at render time, regardless of round (see that function's own
// comment).
export function isDeferredAtRound(severity, round, mediumFixWindow = MEDIUM_FIX_WINDOW) {
  const sev = normalizeSeverity(severity);
  if (!VALID_SEVERITIES.has(sev)) return false;
  if (sev === "high" || sev === "question") return false;
  if (sev === "medium") return round > mediumFixWindow;
  return true; // "low" or "nit" (and any legacy spelling of either)
}

// Per-finding suppression + disposition marker. Deliberately carries no `gate`
// field: the fingerprint dedupe is intentionally cross-gate (a draft-gate
// deferral suppresses re-raising the same finding at pre-approval too).
// `disposition` is optional: pass "deferred" only when the finding is disposed
// as deferred at render time (a body-filed finding, which never gets its own
// resolvable thread, must be stamped up front rather than later). FINDING_MARKER_RE
// (below) only ever accepts the literal `deferred` in that field, so any other
// value would be silently unparseable by this module's own parser — throw here
// instead, at the one place the marker is built, rather than let a producer and
// this module's own reader disagree on the accepted vocabulary.
const VALID_MARKER_DISPOSITIONS = new Set(["deferred"]);

// `issue` is the follow-up GitHub issue number a `disposition=deferred`
// finding is tracked on (#1807, GATE-EXEC-DEFERRAL-RECORD): a deferral must
// never live only in the thread marker and the ephemeral tmp ledger, so the
// marker itself carries the re-attachment pointer.
export function buildFindingMarker({ fp, severity, angle, round, disposition, issue }) {
  if (disposition !== undefined && !VALID_MARKER_DISPOSITIONS.has(disposition)) {
    throw new Error(`buildFindingMarker: disposition must be "deferred" (or omitted), got ${JSON.stringify(disposition)}`);
  }
  if (issue !== undefined && (!Number.isInteger(issue) || issue <= 0)) {
    throw new Error(`buildFindingMarker: issue must be a positive integer (or omitted), got ${JSON.stringify(issue)}`);
  }
  const dispositionField = disposition ? ` disposition=${slugForMarker(disposition)}` : "";
  const issueField = issue !== undefined ? ` issue=${issue}` : "";
  return `<!-- dev-loops:finding ${fp} severity=${slugForMarker(severity)} angle=${slugForMarker(angle)} round=${round}${dispositionField}${issueField} -->`;
}

// Anchored to the START of a line (multiline `m`): a marker quoted mid-line
// inside a finding's own free text (e.g. a recommendation that pastes a prior
// marker as an example) must never be honored as a real marker. Every marker
// this module renders is always the first character of its own line, so this
// anchor costs nothing against genuine markers.
export const FINDING_MARKER_RE = /^<!--\s*dev-loops:finding\s+([0-9a-f]{16})\s+severity=([a-z0-9._-]+)\s+angle=([a-z0-9._-]+)\s+round=(\d+)(?:\s+disposition=(deferred))?(?:\s+issue=(\d+))?\s*-->/m;
const FINDING_MARKER_FP_ONLY_RE = /^<!--\s*dev-loops:finding\s+([0-9a-f]{16})\b/gm;

export function parseFindingMarker(text) {
  const match = typeof text === "string" ? text.match(FINDING_MARKER_RE) : null;
  if (!match) return null;
  return {
    fp: match[1],
    severity: normalizeSeverity(match[2]),
    angle: match[3],
    round: Number(match[4]),
    disposition: match[5] ?? null,
    issue: match[6] ? Number(match[6]) : null,
  };
}

// Round is embedded here (an addition beyond the finding marker's own round=,
// which cannot be reliably attributed back to one gate without a second
// network round-trip) so the round cross-check can be computed from review
// bodies alone, correctly scoped to THIS gate.
export function buildReviewHeaderMarker({ gate, headSha, round }) {
  return `<!-- dev-loops:gate-findings-review ${gate} ${headSha} round=${round} -->`;
}

// Line-start anchored (see FINDING_MARKER_RE): the header this module renders
// is always on its own line, never quoted mid-line.
const REVIEW_HEADER_RE = /^<!--\s*dev-loops:gate-findings-review\s+(draft_gate|pre_approval_gate)\s+([0-9a-f]{7,64})\s+round=(\d+)\s*-->/m;

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

// 16-hex sha256 over path + normalized summary. Line is deliberately excluded
// (it drifts across heads); angle/severity are excluded (a cross-gate or
// cross-severity re-raise of the same underlying finding must still dedupe).
// files[0] is trimmed: the two ledger writers disagree on whether a file entry
// is pre-trimmed (readGateFindingsLedger below normalizes it too, but this is
// cheap belt-and-braces consistency for any other caller of this function).
export function fingerprintFinding(finding) {
  const filePath = Array.isArray(finding.files) && finding.files.length > 0 ? String(finding.files[0]).trim() : "";
  const normalizedSummary = String(finding.summary).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return createHash("sha256").update(`${filePath}|${normalizedSummary}`).digest("hex").slice(0, 16);
}

export function collectFingerprints(text, set) {
  if (typeof text !== "string") return;
  for (const match of text.matchAll(FINDING_MARKER_FP_ONLY_RE)) {
    set.add(match[1]);
  }
}

// ---------------------------------------------------------------------------
// Follow-up issue for deferred findings (#1807)
// ---------------------------------------------------------------------------
//
// A `defer` disposition — the judge's relevance-based defer (judge-pass.mjs)
// or the severity/round-based auto-defer (close-gate-findings.mjs's
// disposition pass) — must never live only in a thread marker and the
// ephemeral tmp findings ledger; it always creates or appends to ONE tracked
// GitHub issue per PR (batched: every finding a PR ever defers is one entry
// on that same issue, never one issue per finding). `existingIssueNumber`,
// when the caller already knows one (a prior round's ledger, or an existing
// thread marker's own `issue=` field), is reused: new entries are appended as
// a comment instead of minting a second issue.

function formatDeferredFindingEntry({ fingerprint, severity, angle, summary, refUrl }) {
  const detail = typeof summary === "string" && summary.trim().length > 0
    ? sanitizeInline(summary.trim())
    : (typeof refUrl === "string" && refUrl.trim().length > 0 ? refUrl.trim() : "(no summary recorded)");
  return `- \`${sanitizeCodeSpan(fingerprint)}\` **${sanitizeInline(normalizeSeverity(severity))}** (\`${sanitizeCodeSpan(angle)}\`): ${detail}`;
}

export function buildFollowUpIssueTitle({ repo, pr }) {
  return `Deferred gate findings for ${repo}#${pr}`;
}

export function buildFollowUpIssueBody({ repo, pr, entries }) {
  const lines = [
    `Gate review findings deferred out of https://github.com/${repo}/pull/${pr}, tracked here instead of only in the gate's thread markers and the ephemeral tmp findings ledger.`,
    "",
    ...entries.map(formatDeferredFindingEntry),
  ];
  return lines.join("\n");
}

export function buildFollowUpIssueAppendComment({ entries }) {
  return [
    "Additional gate finding(s) deferred to this issue:",
    "",
    ...entries.map(formatDeferredFindingEntry),
  ].join("\n");
}

/**
 * Create (or, when `existingIssueNumber` is already known, append a comment
 * to) the ONE tracked follow-up issue for a batch of `defer`-disposed
 * findings on one PR. Returns `{ issueNumber, created }`. The `createIssue` /
 * `commentIssue` dependencies default to the sanctioned core wrappers
 * (`@dev-loops/core/github/issue-ops`) — never a raw `gh` call — and are
 * injectable so a caller/test can stub them without hitting the real API.
 */
export async function ensureFollowUpIssue(
  { repo, pr, entries, existingIssueNumber },
  { env = process.env, ghCommand = "gh", run = defaultRunChild, createIssue = coreCreateIssue, commentIssue = coreCommentIssue } = {},
) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("ensureFollowUpIssue: entries must be a non-empty array");
  }
  if (Number.isInteger(existingIssueNumber) && existingIssueNumber > 0) {
    await commentIssue(
      { repo, issue: existingIssueNumber, body: buildFollowUpIssueAppendComment({ entries }) },
      { env, ghCommand, run },
    );
    return { issueNumber: existingIssueNumber, created: false };
  }
  const result = await createIssue(
    { repo, title: buildFollowUpIssueTitle({ repo, pr }), body: buildFollowUpIssueBody({ repo, pr, entries }) },
    { env, ghCommand, run },
  );
  return { issueNumber: result.issueNumber, created: true };
}

// ---------------------------------------------------------------------------
// Rendering (finding lines, inline comments, body-filed blocks)
// ---------------------------------------------------------------------------

// One deterministic, round-trip-parseable line rendering a finding's
// severity/angle/summary. Shared by inline comments (unblockquoted — inline
// review comments are never scanned by the evidence checker) and body-filed
// blocks (blockquoted by the caller). `severity` is normalized (a legacy
// spelling renders under its canonical replacement) AND sanitized. It renders
// bare — "**${severity}**", never inside a code span — so it needs the same
// bare-prose sanitizer (sanitizeInline) the verdict renderer's
// sanitizeStructuredInline alias already applies to its own bare-prose
// fields, not sanitizeCodeSpan (which leaves a raw `<` and the markdown
// link/image bracket forms live): angle is wrapped in a code span below and
// keeps sanitizeCodeSpan, summary already uses sanitizeInline. Sanitizing
// severity also closes the blockquoted (renderNonLocatableBlock) caller's own
// newline hazard: a newline inside "> **${severity}**" would put every
// following field on its own un-blockquoted line, escaping the blockquote
// this function's own callers document as load-bearing for the evidence
// parser. normalizeSeverity alone is NOT that sanitizer — it only maps a
// legacy spelling to its canonical name, it does not neutralize a hostile
// character — so it is applied here in addition to, never instead of,
// sanitizeInline.
function renderFindingLine({ severity, angle, summary, judgeDisposition }) {
  const safeSeverity = sanitizeInline(normalizeSeverity(severity));
  const judgeSuffix = typeof judgeDisposition === "string" && judgeDisposition.trim().length > 0
    ? ` — judge: ${sanitizeInline(judgeDisposition)}`
    : "";
  return `**${safeSeverity}** (\`${sanitizeCodeSpan(angle)}\`): ${sanitizeInline(summary)}${judgeSuffix}`;
}

function renderRecommendationLine(recommendation) {
  return `Recommendation: ${sanitizeInline(recommendation)}`;
}

function hasRecommendation(finding) {
  return typeof finding.recommendation === "string" && finding.recommendation.trim().length > 0;
}

export function renderInlineCommentBody(finding, { round }) {
  const fp = fingerprintFinding(finding);
  // Normalized ONCE and reused for both the marker and the rendered line
  // (mirrors renderNonLocatableBlock below): a legacy-spelled severity must
  // never render its retired spelling here while its own marker parses back
  // as the canonical one.
  const severity = /** @type {string} */ (normalizeSeverity(finding.severity));
  const lines = [
    buildFindingMarker({ fp, severity, angle: finding.angle, round }),
    renderFindingLine({ ...finding, severity }),
  ];
  if (hasRecommendation(finding)) {
    lines.push(renderRecommendationLine(finding.recommendation));
  }
  return sanitizeCopilotSummonTokens(lines.join("\n"));
}

// Every content line after the marker is blockquoted: this is load-bearing.
// The evidence checker's marker parser strips markdown headers/bold but NOT a
// leading "> ", so no rendered finding line can ever match its line-start
// gate:/head sha:/verdict:/summary: field regex, however a finding's own free
// text is worded. That matters more than ever now that these blocks share a
// body with the genuine verdict fields.
//
// A body-filed finding never gets a resolvable thread (it lives in a review
// body, not a review comment) and so never passes through the thread
// disposition pass (which is where a THREADED medium finding gets its
// round<=3 in-gate fix window before deferring). A body-filed finding has
// no such window to begin with — there is no thread to fix it through — so it
// is deferred BY CONSTRUCTION, at render time, regardless of round: every
// non-high severity (medium, low, nit) is stamped disposition=deferred the
// moment it is posted. high stays unstamped (the ledger blocks a clean
// verdict on it; it is never body-filed as an accepted outcome). A question is
// also stamped deferred here for the same structural reason (no thread to
// answer it through) — the answered/never-deferred contract only applies to a
// LOCATABLE question's own resolvable thread. This is what keeps the finding
// from being suppressed by its own fingerprint (fingerprintFinding, matched
// back on a later run via collectFingerprints) while tracked nowhere else
// (fingerprint suppression + zero surface = permanent silent loss).
export function renderNonLocatableBlock(finding, { round }) {
  const fp = fingerprintFinding(finding);
  // Normalized ONCE and reused for both the disposition decision and the
  // marker: deciding disposition off a raw, un-normalized legacy spelling
  // would misclassify it (e.g. "must-fix" !== "high"). The rendered
  // "> **${severity}**" line goes through renderFindingLine below, which
  // normalizes AND sanitizes severity again on its own — normalization alone
  // is not a sanitizer, so this outer normalize is not what keeps a hostile
  // (e.g. newline-bearing) severity out of the posted body; that guarantee
  // lives in renderFindingLine's own sanitizeInline call on severity.
  const severity = /** @type {string} */ (normalizeSeverity(finding.severity));
  const disposition = severity === "high" ? undefined : "deferred";
  const lines = [
    buildFindingMarker({ fp, severity, angle: finding.angle, round, disposition }),
    `> ${renderFindingLine({ ...finding, severity })}`,
  ];
  if (hasRecommendation(finding)) {
    lines.push(`> ${renderRecommendationLine(finding.recommendation)}`);
  }
  if (Array.isArray(finding.files) && finding.files.length > 0) {
    // The line ref belongs to files[0] (the anchor isLocatableFinding keys on),
    // so it renders INSIDE that entry's own code span rather than trailing the
    // whole list, where it would read as belonging to the last file instead.
    const lineRef = Number.isInteger(finding.line) ? `:${finding.line}` : "";
    const refs = finding.files
      .map((f, i) => `\`${sanitizeCodeSpan(f)}${i === 0 ? lineRef : ""}\``)
      .join(", ");
    lines.push(`> Location: ${refs}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Out-of-diff detection (pulls/{n}/files patch walk)
// ---------------------------------------------------------------------------

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// Build the set of "<path>:<line>" pairs GitHub will accept an inline (side
// RIGHT) review comment on: every context or added line inside a diff hunk. A
// removed-only ('-') line only exists on the old (LEFT) side and never
// advances the new-file line counter.
export function buildCommentableLineSet(files) {
  const set = new Set();
  for (const file of files) {
    const filename = typeof file?.filename === "string" ? file.filename : null;
    const patch = typeof file?.patch === "string" ? file.patch : null;
    if (!filename || !patch) continue;
    let newLine = null;
    for (const rawLine of patch.split("\n")) {
      const hunk = rawLine.match(HUNK_HEADER_RE);
      if (hunk) {
        newLine = Number(hunk[1]);
        continue;
      }
      if (newLine === null) continue;
      if (rawLine.startsWith("+") || rawLine.startsWith(" ")) {
        set.add(`${filename}:${newLine}`);
        newLine += 1;
      }
      // '-' (old-file-only) and '\' (no-newline marker) do not advance the
      // new-file line counter.
    }
  }
  return set;
}

export function isLocatableFinding(finding, commentableSet) {
  // hasLocatableShape (@dev-loops/core/loop/gate-fanin) is the shared shape
  // floor every producer/consumer of the locatable/non-locatable distinction
  // uses; this adds the one thing only a caller holding the diff can check —
  // whether that file:line actually falls inside it.
  if (!hasLocatableShape(finding)) return false;
  return commentableSet.has(`${finding.files[0]}:${finding.line}`);
}

// ---------------------------------------------------------------------------
// Ledger read + validate
// ---------------------------------------------------------------------------

/**
 * Read and validate a write-gate-findings-log.mjs ledger.
 * `errorFactory` lets a CLI attach its own `usage` payload to every validation
 * failure without this module knowing about any one CLI's usage text.
 */
export async function readGateFindingsLedger(ledgerPath, { errorFactory = (message) => new Error(message) } = {}) {
  const fail = (message) => errorFactory(message);
  let raw;
  try {
    raw = await readFile(ledgerPath, "utf8");
  } catch (err) {
    throw fail(`Cannot read gate findings ledger "${ledgerPath}": ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw fail(`Gate findings ledger "${ledgerPath}" must contain valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw fail(`Gate findings ledger "${ledgerPath}" must contain a JSON object`);
  }
  const { repo, pr, gate, headSha, verdict, findings } = parsed;
  // The consolidator's computed verdict, threaded from `--ledger-out`'s
  // wrapper by write-gate-findings-log.mjs. Optional and additive: when absent
  // the ledger reads exactly as before (inline and fallback paths unaffected).
  // Fail closed on a present-but-invalid value rather than silently treating it
  // as absent (#1616): a malformed `overallVerdict` must not let a contradicting
  // `--verdict` slip through enforcement by defaulting to "no overallVerdict".
  const overallVerdictRaw = parsed.overallVerdict;
  if (overallVerdictRaw !== undefined) {
    if (!VALID_LEDGER_VERDICTS.has(overallVerdictRaw)) {
      throw fail(`Gate findings ledger "${ledgerPath}" "overallVerdict" must be clean, findings_present, or blocked (got: ${JSON.stringify(overallVerdictRaw)})`);
    }
  }
  let repoSlug;
  try {
    const { owner, name } = parseRepoSlug(typeof repo === "string" ? repo.trim() : repo);
    repoSlug = `${owner}/${name}`;
  } catch {
    throw fail(`Gate findings ledger "${ledgerPath}" "repo" must be an owner/name slug`);
  }
  if (!Number.isInteger(pr) || pr <= 0) {
    throw fail(`Gate findings ledger "${ledgerPath}" is missing a valid "pr" number`);
  }
  if (!VALID_GATES.has(gate)) {
    throw fail(`Gate findings ledger "${ledgerPath}" "gate" must be draft_gate or pre_approval_gate`);
  }
  const fullHeadSha = normalizeFullHeadSha(headSha);
  if (fullHeadSha === null) {
    throw fail(`Gate findings ledger "${ledgerPath}" "headSha" must be the full 40- or 64-char hex commit SHA`);
  }
  if (!VALID_LEDGER_VERDICTS.has(verdict)) {
    throw fail(`Gate findings ledger "${ledgerPath}" "verdict" must be clean, findings_present, or blocked`);
  }
  if (!Array.isArray(findings)) {
    throw fail(`Gate findings ledger "${ledgerPath}" "findings" must be an array`);
  }
  findings.forEach((f, i) => {
    if (f && typeof f === "object") f.severity = normalizeSeverity(f.severity);
    if (!f || typeof f !== "object" || !VALID_SEVERITIES.has(f.severity) || typeof f.angle !== "string" || typeof f.summary !== "string") {
      throw fail(`Gate findings ledger "${ledgerPath}" findings[${i}] is malformed (expected {severity, angle, summary})`);
    }
    if ("line" in f && f.line !== undefined && (!Number.isInteger(f.line) || f.line < 1)) {
      throw fail(`Gate findings ledger "${ledgerPath}" findings[${i}].line must be a positive integer`);
    }
    if ("files" in f && f.files !== undefined) {
      if (!Array.isArray(f.files)) {
        throw fail(`Gate findings ledger "${ledgerPath}" findings[${i}].files must be an array`);
      }
      f.files.forEach((entry, j) => {
        if (typeof entry !== "string" || entry.trim().length === 0) {
          throw fail(`Gate findings ledger "${ledgerPath}" findings[${i}].files[${j}] must be a non-empty string`);
        }
      });
    }
  });
  // Trim each files[] entry so the SAME finding fingerprints identically
  // regardless of which ledger writer produced it (write-gate-findings-log.mjs
  // filters blank entries but does not trim; a hand-authored path can carry an
  // untrimmed value). fingerprintFinding also trims defensively, but
  // normalizing here keeps every downstream consumer (isLocatableFinding's
  // commentable-set lookup, the posted review `path`, renderNonLocatableBlock's
  // Location line) on the same trimmed value too.
  const normalizedFindings = findings.map((f) => (
    Array.isArray(f.files) ? { ...f, files: f.files.map((entry) => entry.trim()) } : f
  ));
  // `provenance` is passed through UNVALIDATED (write-gate-findings-log.mjs
  // validates it at write time via provenanceConsistencyError only when the
  // ledger was written with --provenance); a
  // reader that needs to trust it (e.g. upsert-checkpoint-verdict.mjs's
  // withheld-tier mandatory-angle check) re-validates with the same function
  // rather than assuming a hand-edited or shadow ledger is honest.
  const provenance = parsed.provenance !== undefined ? parsed.provenance : null;
  return { repo: repoSlug, pr, gate, headSha: fullHeadSha, verdict, findings: normalizedFindings, provenance, overallVerdict: overallVerdictRaw !== undefined ? overallVerdictRaw : null };
}

// ---------------------------------------------------------------------------
// gh plumbing
// ---------------------------------------------------------------------------

/** One assertion for every gh invocation in the gate finding-surface paths. */
function assertGhSuccess(result) {
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
}

// The one spelling of the reviews endpoint every reader shares (the path is
// exported separately for callers that also need a REST fallback URL).
export const prReviewsApiPath = (repo, pr) => `repos/${repo}/pulls/${pr}/reviews?per_page=100`;
export const prReviewsApiArgs = (repo, pr) => ["api", "--paginate", "--slurp", prReviewsApiPath(repo, pr)];

export async function listPrReviews({ repo, pr }, { env, ghCommand, runChild }) {
  const payload = await runGhJson(prReviewsApiArgs(repo, pr), { env, ghCommand, runChild });
  // A PENDING (unsubmitted) review must never feed round resolution or
  // fingerprint suppression any more than it may feed verdict evidence.
  return flattenPaginatedSlurp(payload)
    .filter(isSubmittedReview)
    .map((r) => ({
      id: Number.isInteger(r.id) ? r.id : null,
      body: r.body,
      author: typeof r?.user?.login === "string" && r.user.login.length > 0 ? r.user.login : null,
    }));
}

/**
 * Read every comment-shaped body a gate verdict can live on: the issue-comment
 * stream (verdicts posted by earlier versions) plus the PR review stream (the
 * round's single visible surface today). The reviews read is FAIL-OPEN by
 * default — a legacy issue-comment verdict still validates on its own — while
 * the issue-comment read stays fail-closed, exactly as each caller behaved
 * before this became one function.
 *
 * When `reportSurfaces` is set, a consumer that must know WHICH surface it
 * actually scanned (an audit tool that would otherwise overclaim a review read
 * that silently failed) gets back `{ comments, surfaces }` listing exactly the
 * surfaces successfully read — never a review surface whose gh read failed.
 * This keeps the default fail-open behavior for all existing callers while
 * giving the audit a truthful surface list (no silent false-missing).
 */
export async function fetchGateEvidenceComments({ repo, pr }, { env, ghCommand, runChild = defaultRunChild, reportSurfaces = false } = {}) {
  const comments = await listIssueComments({ repo, pr }, { env, ghCommand, runChild });
  const surfaces = [];
  let reviewSurfaceRead = false;
  try {
    const reviews = await runGhJson(prReviewsApiArgs(repo, pr), { env, ghCommand, runChild });
    comments.push(...normalizePrReviewsPayload(reviews));
    reviewSurfaceRead = true;
  } catch {
    // Non-fatal: continue on the issue-comment stream alone.
  }
  if (reviewSurfaceRead) surfaces.push("review");
  surfaces.push("issue_comment");
  return reportSurfaces ? { comments, surfaces } : comments;
}

/**
 * Count unresolved GATE-AUTHORED review threads — threads whose first comment
 * was authored by the gate's own login (`login`) and carries a parseable
 * `dev-loops:finding` marker (any severity: high, medium, low, question, OR
 * nit). This is the gate-close predicate #1585 wires into
 * `fetchDraftGateEvidence`: a clean verdict alone no longer satisfies the
 * gate — every gate-authored thread must be resolved (fix-closed by the fixer
 * or defer-closed by the disposition pass) first.
 *
 * When `login` is `null`, the author-identity check is skipped and the count
 * is MARKER-ONLY (any unresolved thread carrying a finding marker). That is a
 * deliberately fail-closed proxy — a foreign comment that quotes a real marker
 * would over-count and block, which is safe (the gate waits) rather than
 * under-counting and proceeding. The disposition pass
 * (`selectDispositionTargets` in close-gate-findings.mjs) uses author identity
 * because it MUTATES threads (forgery matters there); this read-only counter
 * accepts the marker-only fallback so a caller without a resolved login (e.g.
 * detect-checkpoint-evidence reusing an existing thread payload) can still
 * assert the gate-close invariant without an extra `api user` round-trip.
 *
 * `threads` is the shape `fetchAllReviewThreads` (list-review-threads.mjs)
 * returns: `{ author, body, isResolved, ... }`.
 */
export function countUnresolvedGateAuthoredThreads(threads, login) {
  // A non-array `threads` is a caller contract violation; for a gate-close
  // safety predicate the fail-closed posture is to THROW (callers catch and
  // treat the unreadable state as -1 / blocked), never to silently coerce to
  // an empty array and under-count dangling threads (#1585 review finding).
  if (!Array.isArray(threads)) {
    throw new Error(`countUnresolvedGateAuthoredThreads: threads must be an array, got ${typeof threads}`);
  }
  // Any falsy login (null/undefined/"") falls back to the MARKER-ONLY fail-closed
  // proxy — an empty-string login must NOT silently skip every thread (fail-open);
  // it must over-count and block, matching the documented posture.
  const loginKnown = typeof login === "string" && login.length > 0;
  let count = 0;
  for (const thread of threads) {
    if (thread.isResolved) continue;
    if (loginKnown && thread.author !== login) continue;
    if (!parseFindingMarker(thread.body)) continue;
    count += 1;
  }
  return count;
}

/**
 * Map the raw GraphQL review-thread nodes `fetchGithubReviewThreadsPayload`
 * (capture-review-threads.mjs) returns onto the `{ author, body, isResolved }`
 * shape `countUnresolvedGateAuthoredThreads` consumes, then count unresolved
 * gate-authored threads MARKER-ONLY (`login=null`). Lets a caller that already
 * fetched the raw thread payload reuse it for the gate-close assertion instead
 * of issuing a second thread walk.
 */
export function countUnresolvedGateAuthoredThreadsFromRawNodes(rawNodes) {
  // A non-array `rawNodes` is a caller contract violation; for a gate-close
  // safety predicate, fail CLOSED — let the TypeError propagate to the caller's
  // catch (detect-checkpoint-evidence sets unresolvedGateThreadCount = -1 /
  // blocked) rather than silently coerce to [] and under-count (#1585 review).
  if (!Array.isArray(rawNodes)) {
    throw new Error(`countUnresolvedGateAuthoredThreadsFromRawNodes: rawNodes must be an array, got ${typeof rawNodes}`);
  }
  const threads = rawNodes.map((node) => {
    const firstComment = node?.comments?.nodes?.[0] ?? null;
    return {
      author: typeof firstComment?.author?.login === "string" && firstComment.author.login.length > 0
        ? firstComment.author.login
        : null,
      body: typeof firstComment?.body === "string" ? firstComment.body : "",
      isResolved: Boolean(node?.isResolved),
    };
  });
  return countUnresolvedGateAuthoredThreads(threads, null);
}

/**
 * Fetch the unresolved gate-authored thread count for a PR. Resolves the
 * authenticated login once (the trust boundary for the gate-authored
 * provenance decision, identical to `selectDispositionTargets`' author check)
 * and lists review threads, then counts the unresolved gate-authored ones.
 * Throws on gh failure — callers (fetchDraftGateEvidence) catch and treat the
 * unreadable state as fail-closed (-1): the gate cannot assert 0 unresolved, so
 * it blocks rather than guessing clean.
 */
export async function fetchUnresolvedGateThreadCount({ repo, pr }, gh) {
  const login = await resolveAuthenticatedLogin(gh);
  const threads = await fetchAllReviewThreads({ repo, pr }, gh);
  return countUnresolvedGateAuthoredThreads(threads, login);
}

/**
 * Summarize the draft-gate evidence the `gh pr ready` guards decide on, read
 * from BOTH surfaces. One function so the hook guard (pre-pr-ready-gate.mjs)
 * and the wrapper that performs the transition (ready-for-review.mjs) can never
 * disagree about what counts as evidence.
 *
 * #1585: a clean verdict is NO LONGER sufficient to satisfy the gate. Every
 * gate-authored review thread (high, medium, low, question, AND nit)
 * must be resolved first — the fixer triages every gate-authored finding
 * (fix-if-cheap-in-the-same-commit, else defer) and the disposition pass
 * (close-gate-findings) defer-closes what remains — so the gate-close
 * assertion here refuses ready-for-review while any gate-authored thread still
 * dangles. `unresolvedGateThreadCount` is fail-closed (-1) when the
 * thread/login state cannot be read.
 */
export async function fetchDraftGateEvidence({ repo, pr, headSha }, gh) {
  const comments = await fetchGateEvidenceComments({ repo, pr }, gh);
  const summary = summarizeGateReviewComments(comments).draft_gate;
  const marker = summarizeGateReviewCommentMarkers(comments, { headSha }).draft_gate;
  const draftGate = summary ? { ...summary, visible: true } : { visible: false };
  const draftGateMarker = marker
    ? { ...marker, visible: true, contractComplete: marker.contractComplete === true }
    : { visible: false, contractComplete: false };
  // #1585: a clean verdict is necessary but NO LONGER sufficient to close the
  // gate. The verdict-clean flags below stay VERDICT-ONLY (unchanged) so a
  // verdict/head mismatch is reported distinctly from an unresolved-thread
  // mismatch; the unresolved-gate-authored-thread count is a SEPARATE field the
  // callers (pre-pr-ready-gate / ready-for-review) assert alongside the verdict
  // check. Fail-closed (-1) when the thread/login state is unreadable: the
  // callers treat a non-zero count (including -1) as gate-close-blocked.
  let unresolvedGateThreadCount;
  try {
    unresolvedGateThreadCount = await fetchUnresolvedGateThreadCount({ repo, pr }, gh);
  } catch {
    unresolvedGateThreadCount = -1;
  }
  // Marker match: the current head starts with the marker's recorded (often
  // abbreviated) head SHA.
  const currentHeadClean = Boolean(
    draftGateMarker.visible && draftGateMarker.headSha && headSha
    && headSha.startsWith(draftGateMarker.headSha)
    && draftGateMarker.verdict === "clean" && draftGateMarker.contractComplete,
  );
  // Legacy (non-marker) draft_gate verdict.
  const cleanEvidenceExists = Boolean(draftGate.visible && draftGate.verdict === "clean" && draftGate.headSha);
  const legacyHeadMatch = Boolean(!currentHeadClean && cleanEvidenceExists && headSha && headSha.startsWith(draftGate.headSha));
  return {
    draftGate,
    draftGateMarker,
    unresolvedGateThreadCount,
    currentHeadClean,
    cleanEvidenceExists,
    effectiveHeadClean: currentHeadClean || legacyHeadMatch,
  };
}

export async function fetchPrFiles({ repo, pr }, { env, ghCommand, runChild }) {
  const payload = await runGhJson(
    ["api", "--paginate", "--slurp", `repos/${repo}/pulls/${pr}/files?per_page=100`],
    { env, ghCommand, runChild },
  );
  return flattenPaginatedSlurp(payload);
}

// ---------------------------------------------------------------------------
// The single visible gate surface: one PR review of type COMMENT
// ---------------------------------------------------------------------------

function parseReviewMutationResponse(payload) {
  const id = Number.isInteger(payload?.id) ? payload.id : null;
  const url = typeof payload?.html_url === "string" && payload.html_url.trim().length > 0
    ? payload.html_url.trim()
    : null;
  if (id === null) {
    throw new Error("Gate review mutation did not return a review id");
  }
  return { reviewId: id, reviewUrl: url };
}

/**
 * Create the round's ONE review: the verdict-marker body plus one inline
 * comment per locatable finding. GitHub 422s a COMMENT-event review with an
 * empty body, so the caller must always pass a rendered body.
 */
export async function createGateReview({ repo, pr, headSha, body, comments, allowedRefs }, { env, ghCommand, runChild = defaultRunChild }) {
  // ISSUE/PR-ID GUARD: refuse a verdict body or inline finding comment
  // that emits a raw issue/PR id (fail-closed) unless explicitly allowlisted.
  guardCommentBodyNoIssuePrIds(body, { ref: "gate verdict comment body", allowedRefs });
  for (const comment of comments ?? []) {
    guardCommentBodyNoIssuePrIds(comment?.body, { ref: "gate review inline finding comment", allowedRefs });
  }
  const payload = { commit_id: headSha, event: "COMMENT", body, comments };
  const result = await runChild(
    ghCommand,
    ["api", "-X", "POST", `repos/${repo}/pulls/${pr}/reviews`, "--input", "-"],
    env,
    `${JSON.stringify(payload)}\n`,
  );
  assertGhSuccess(result);
  return parseReviewMutationResponse(parseJsonText(result.stdout, { label: "gh api pulls reviews (POST)" }));
}

/**
 * Correct an existing same-head gate review in place. Only the BODY is
 * mutable this way — GitHub has no endpoint to add inline comments to an
 * already-submitted review — which is exactly why the caller body-files every
 * still-unposted finding on the update path.
 */
export async function updateGateReview({ repo, pr, reviewId, body, allowedRefs }, { env, ghCommand, runChild = defaultRunChild }) {
  // ISSUE/PR-ID GUARD — see createGateReview.
  guardCommentBodyNoIssuePrIds(body, { ref: "gate verdict comment body", allowedRefs });
  const result = await runChild(
    ghCommand,
    ["api", "-X", "PUT", `repos/${repo}/pulls/${pr}/reviews/${reviewId}`, "--input", "-"],
    env,
    `${JSON.stringify({ body })}\n`,
  );
  assertGhSuccess(result);
  return parseReviewMutationResponse(parseJsonText(result.stdout, { label: "gh api pulls reviews (PUT)" }));
}

// ---------------------------------------------------------------------------
// Round determination
// ---------------------------------------------------------------------------

// A genuine gate verdict surface always carries
// upsert-checkpoint-verdict.mjs's own render header ("### Gate review:
// `<gate>`") — a literal shape no other machine-authored gate artifact in this
// repo renders. Matching that (via the core-owned matchGateReviewCommentHeader)
// rather than the LENIENT field parser (parseGateReviewCommentMarkerBody, which
// accepts a bare gate name plus any hex token anywhere in the body) is what
// keeps this count scoped to real verdicts. It is line-start anchored, so a
// quoted header in a reply can't count.
//
// The literal "**Reviewed head SHA:** `<sha>`" line renderGateReviewCommentBody
// always renders immediately after the header identifies WHICH head a matched
// body is evidence for. Round source (A) is the SIZE of the SET of distinct
// reviewed-head SHAs collected across BOTH the PR-review and issue-comment
// streams, never an additive raw count: the sanctioned producer now posts a PR
// review, while historical rounds (and any hand-posted verdict) live on the
// issue-comment stream, so a verdict for the SAME head can exist on both.
// Deduping by head means that duplication can never inflate the round and end
// the medium fix window early. A body that matches the header literal
// but carries no parseable reviewed-head line contributes nothing — it cannot
// be a genuine verdict for any distinguishable head, so it must not count.
const REVIEWED_HEAD_SHA_RE = /^\*\*Reviewed head SHA:\*\*\s*`([0-9a-f]{7,64})`\s*$/m;

function extractReviewedHeadSha(body) {
  const match = typeof body === "string" ? body.match(REVIEWED_HEAD_SHA_RE) : null;
  return match ? match[1].toLowerCase() : null;
}

export function collectVerdictHeadShas(comments, gate, headShas) {
  for (const comment of comments) {
    if (matchGateReviewCommentHeader(comment?.body) !== gate) continue;
    const headSha = extractReviewedHeadSha(comment.body);
    if (headSha) headShas.add(headSha);
  }
}

// Scoped strictly to review bodies that carry THIS gate's own header marker —
// never mixes draft_gate/pre_approval_gate round numbers together. Only the
// header's own round= is read: the poster stamps the header and every finding
// marker in that same body from the SAME `round` variable, and an
// inline-comment finding marker (a locatable finding's own thread) never
// appears in a review BODY at all — only in the separate review comment GitHub
// attaches it to — so scanning finding markers here could never find a round
// the header does not already carry.
function crossCheckRoundFromReviewBodies(bodies, gate) {
  let max = 0;
  for (const body of bodies) {
    if (typeof body !== "string") continue;
    const header = body.match(REVIEW_HEADER_RE);
    if (!header || header[1] !== gate) continue;
    max = Math.max(max, Number(header[3]));
  }
  return max;
}

async function countLocalFindingsLogFiles({ repo, pr, gate, headSha, tmpRoot, repoRoot }) {
  const samplePath = buildLogPath({ repo, pr, gate, headSha, tmpRoot });
  const dir = path.resolve(repoRoot, path.dirname(samplePath));
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  const prefix = `${gate}-`;
  return entries.filter((name) => name.startsWith(prefix) && name.endsWith(".json")).length;
}

/**
 * Resolve this gate round's number as the MAXIMUM of three
 * worktree-independent-first sources:
 *   (A) count of DISTINCT reviewed-head SHAs across this gate's own verdict
 *       surfaces (PR review bodies plus issue comments), UNIONED with the head
 *       being reviewed right now — so the poster computing the round BEFORE it
 *       posts and a later reader computing it AFTER agree on the same number,
 *       and a same-head rerun never advances it;
 *   (B) the highest round= on this gate's own posted review headers (the
 *       "gate-findings-review <gate>" marker, so rounds never mix across gates);
 *   (C) count of local <gate>-*.json findings-log files under tmpRoot.
 * (A) is primary and survives a fresh worktree/clone; (B) and (C) are
 * cross-checks that can only push the round number UP, never down.
 */
export async function resolveGateRound({ repo, pr, gate, headSha, reviews, issueComments, tmpRoot = "tmp", repoRoot = process.cwd() }) {
  const verdictHeadShas = new Set([String(headSha).toLowerCase()]);
  collectVerdictHeadShas(issueComments ?? [], gate, verdictHeadShas);
  collectVerdictHeadShas(reviews ?? [], gate, verdictHeadShas);
  const crossCheckRound = crossCheckRoundFromReviewBodies((reviews ?? []).map((r) => r.body), gate);
  const fallbackRound = await countLocalFindingsLogFiles({ repo, pr, gate, headSha, tmpRoot, repoRoot });
  return Math.max(verdictHeadShas.size, crossCheckRound, fallbackRound, 1);
}

// ---------------------------------------------------------------------------
// Review threads with full first-comment bodies
// ---------------------------------------------------------------------------

// list-review-threads.mjs's fetchAllReviewThreads deliberately excerpts each
// thread's first-comment body to a bounded length for cheap listing. Every
// decision made off a thread body (marker parsing, disposition, suppression)
// needs the UNTRUNCATED body, so join the listing (threadId/commentId/path/
// line/isResolved) with captureParsedReviewThreads' full first-comment text,
// keyed on the comment databaseId the two share. The two are INDEPENDENT
// paginated GraphQL walks, though: a thread created or cursor-shifted between
// them can be present in one and absent from the other, so a join miss must
// fail closed rather than silently fall back to the truncated excerpt (which
// could run every downstream decision on a body cut mid-marker, varying with
// fetch interleaving alone). The excerpt is self-identifying — excerptBody only
// ever appends a trailing U+2026 when the body's length actually exceeded
// BODY_EXCERPT_MAX_CHARS — so only fail when the join misses AND the listing
// body is BOTH over that length AND ends with the ellipsis; a short body that
// legitimately ends with its own literal "…" character (a reviewer's own prose)
// never needed truncation and is already complete, so it is safe to keep as-is.
const BODY_EXCERPT_ELLIPSIS = "…";

// Only a non-empty string body is a usable join hit. A comment whose
// databaseId resolves but whose body is missing/empty (a minimized comment, a
// GraphQL field genuinely absent) must NOT silently blank a thread's body —
// that thread has a real listing excerpt already, and replacing it with "" is
// strictly worse than a join MISS (which at least falls through to the
// existing-excerpt/truncation check below); "" simply drops the thread out of
// marker parsing, disposition, and suppression with no signal at all.
function buildFullBodyByCommentId(comments) {
  const map = new Map();
  for (const comment of comments) {
    if (typeof comment?.databaseId === "string" && comment.databaseId.length > 0
      && typeof comment.body === "string" && comment.body.length > 0) {
      map.set(comment.databaseId, comment.body);
    }
  }
  return map;
}

function isTruncatedListingExcerpt(body) {
  return typeof body === "string" && body.length > BODY_EXCERPT_MAX_CHARS && body.endsWith(BODY_EXCERPT_ELLIPSIS);
}

export async function fetchThreadsWithFullBodies({ repo, pr }, gh) {
  const threads = await fetchAllReviewThreads({ repo, pr }, gh);
  const snapshot = await captureParsedReviewThreads({ repo, pr }, gh);
  const fullBodyByCommentId = buildFullBodyByCommentId(snapshot.comments);
  const threadsWithFullBodies = threads.map((thread) => {
    if (thread.commentId === null) {
      // No databaseId means the join key itself is unavailable for this
      // thread — it can never be found in fullBodyByCommentId no matter how
      // the two walks interleave, so treat this exactly like a join miss
      // rather than silently returning the (possibly truncated) excerpt.
      if (isTruncatedListingExcerpt(thread.body)) {
        throw new Error(`Could not resolve the full body for review thread ${thread.threadId}: the listing excerpt was truncated and the thread has no comment id to join the full body against.`);
      }
      return thread;
    }
    const fullBody = fullBodyByCommentId.get(String(thread.commentId));
    if (fullBody !== undefined) return { ...thread, body: fullBody };
    if (isTruncatedListingExcerpt(thread.body)) {
      throw new Error(`Could not resolve the full body for review comment ${thread.commentId}: the listing excerpt was truncated and the full-body join missed it.`);
    }
    return thread;
  });
  return { threads: threadsWithFullBodies, snapshot };
}

/**
 * Fold every OWN-AUTHORED review body and review thread's finding fingerprints
 * into a suppression set. A foreign review or thread quoting (or forging) a
 * marker that happens to fingerprint-match a real finding must never silently
 * suppress it from being re-raised.
 */
export function collectSuppressedFingerprints({ reviews, threads, login }) {
  const suppressed = new Set();
  for (const review of reviews ?? []) {
    if (review.author === login) collectFingerprints(review.body, suppressed);
  }
  for (const thread of threads ?? []) {
    if (thread.author === login) collectFingerprints(thread.body, suppressed);
  }
  return suppressed;
}
