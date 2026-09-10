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
import { createIssue as coreCreateIssue, commentIssue as coreCommentIssue, listIssues as coreListIssues } from "@dev-loops/core/github/issue-ops";
import { VALID_SEVERITIES, hasLocatableShape, normalizeSeverity, resolveFindingFile } from "@dev-loops/core/loop/gate-fanin";
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
import { guardCommentBodyNoIssuePrIds, neutralizeBareIssuePrIds } from "@dev-loops/core/github/comment-id-guard";
import { GATE_NAMES, GATE_VERDICTS } from "./_gate-names.mjs";

// The one predicate for "counts as a submitted review with content": every
// consumer (verdict evidence, round resolution, fingerprint suppression) MUST
// share this function, never restate the expression — two restatements
// drifted apart once already.
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

const VALID_LEDGER_VERDICTS = new Set(GATE_VERDICTS);
const VALID_GATES = new Set(GATE_NAMES);

// Findings at round <= this stay in the standard fix loop; from the next round
// on, an open medium finding is deferred instead of re-fixed in-gate.
export const MEDIUM_FIX_WINDOW = 3;

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

// Slugs a marker field to a single safe token: a stray space would split the
// marker into unparseable garbage, and an over-long value would push it past
// list-review-threads.mjs's 200-char listing excerpt, silently hiding the
// thread from disposition and the unresolved-thread gate check.
const MARKER_FIELD_MAX_CHARS = 40;

function slugForMarker(value) {
  const slug = String(value).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const bounded = slug.length > MARKER_FIELD_MAX_CHARS ? slug.slice(0, MARKER_FIELD_MAX_CHARS) : slug;
  return bounded.length > 0 ? bounded : "unknown";
}

// Severity-to-disposition mapping for the THREAD disposition pass (a
// locatable finding's own resolvable review thread) at the CURRENT round:
// high never defers; medium defers past the in-gate fix window; low and nit
// always defer immediately; question never defers (it is answered, not
// deferred — unanswered, it blocks gate-close as an unresolved thread, like
// an open defect). An unrecognized severity fails CLOSED (false): a
// malformed/forged marker must surface as a dangling gate-authored thread,
// never get silently stamped `disposition=deferred` like a genuine low/nit.
// renderNonLocatableBlock (body-filed findings) deliberately does not call
// this: a body-filed finding never gets a thread to fix through, so it is
// stamped deferred unconditionally at render time regardless of round.
export function isDeferredAtRound(severity, round, mediumFixWindow = MEDIUM_FIX_WINDOW) {
  const sev = normalizeSeverity(severity);
  if (!VALID_SEVERITIES.has(sev)) return false;
  if (sev === "high" || sev === "question") return false;
  if (sev === "medium") return round > mediumFixWindow;
  return true; // "low" or "nit" (and any legacy spelling of either)
}

// The net-reduction filing bar: resolving a thread (isDeferredAtRound)
// and FILING it on the follow-up issue are different decisions. `nit` is
// NEVER fileable — resolved-with-rationale in-thread only, a resolved nit is
// cosmetic, not a backlog item. `low` is fileable ONLY when its own marker
// carries the explicit `operatorVisible` signal (`ov=1`, set from the
// finding's own `operatorVisible: true`); the default (absent/false) is the
// conservative, net-negative-backlog choice. `medium` past its fix window is
// always fileable. `high`/`question` are never resolved here to begin with,
// so never fileable. Governs whether close-gate-findings.mjs's disposition
// pass calls ensureFollowUpIssue/stampDeferredDisposition, and (via
// detectContractViolatingDeferredStamps) whether an already-stamped
// `disposition=deferred` marker is legitimate.
export function isFileableDeferral(severity, operatorVisible, round, mediumFixWindow = MEDIUM_FIX_WINDOW) {
  const sev = normalizeSeverity(severity);
  if (sev === "medium") return round > mediumFixWindow;
  if (sev === "low") return operatorVisible === true;
  return false; // "nit" (never fileable), "high"/"question" (never resolved here)
}

// Per-finding suppression + disposition marker. Deliberately carries no `gate`
// field: the fingerprint dedupe is intentionally cross-gate (a draft-gate
// deferral suppresses re-raising the same finding at pre-approval too).
// `disposition` is optional: pass "deferred" only when the finding is disposed
// as deferred at render time (a body-filed finding, which never gets its own
// resolvable thread, must be stamped up front). FINDING_MARKER_RE (below)
// only accepts the literal `deferred` here, so throw at the one place the
// marker is built rather than let a producer and reader disagree.
const VALID_MARKER_DISPOSITIONS = new Set(["deferred"]);

// `issue` is the follow-up GitHub issue number a `disposition=deferred`
// finding is tracked on (GATE-EXEC-DEFERRAL-RECORD): a deferral must
// never live only in the thread marker and the ephemeral tmp ledger, so the
// marker itself carries the re-attachment pointer.
//
// `operatorVisible` is the explicit operator-visibility signal a `low`
// finding's own producer attaches — rendered as the marker's `ov=1` field
// only when `operatorVisible === true`; omitted (the default) is NOT
// operator visible. This is the ONE place the signal is defined: a producer
// sets `operatorVisible: true` on the finding object fed through the ledger
// (write-gate-findings-log.mjs's `--findings`/`--findings-file`); nothing
// infers visibility from a finding's own text. `isFileableDeferral` is the
// sole consumer.
export function buildFindingMarker({ fp, severity, angle, round, operatorVisible, disposition, issue }) {
  if (operatorVisible !== undefined && typeof operatorVisible !== "boolean") {
    throw new Error(`buildFindingMarker: operatorVisible must be a boolean (or omitted), got ${JSON.stringify(operatorVisible)}`);
  }
  if (disposition !== undefined && !VALID_MARKER_DISPOSITIONS.has(disposition)) {
    throw new Error(`buildFindingMarker: disposition must be "deferred" (or omitted), got ${JSON.stringify(disposition)}`);
  }
  if (issue !== undefined && (!Number.isInteger(issue) || issue <= 0)) {
    throw new Error(`buildFindingMarker: issue must be a positive integer (or omitted), got ${JSON.stringify(issue)}`);
  }
  const operatorVisibleField = operatorVisible === true ? " ov=1" : "";
  const dispositionField = disposition ? ` disposition=${slugForMarker(disposition)}` : "";
  const issueField = issue !== undefined ? ` issue=${issue}` : "";
  return `<!-- dev-loops:finding ${fp} severity=${slugForMarker(severity)} angle=${slugForMarker(angle)} round=${round}${operatorVisibleField}${dispositionField}${issueField} -->`;
}

// Anchored to the START of a line (multiline `m`): a marker quoted mid-line
// inside a finding's own free text (e.g. a recommendation that pastes a prior
// marker as an example) must never be honored as a real marker. Every marker
// this module renders is always the first character of its own line, so this
// anchor costs nothing against genuine markers.
export const FINDING_MARKER_RE = /^<!--\s*dev-loops:finding\s+([0-9a-f]{16})\s+severity=([a-z0-9._-]+)\s+angle=([a-z0-9._-]+)\s+round=(\d+)(?:\s+ov=(1))?(?:\s+disposition=(deferred))?(?:\s+issue=(\d+))?\s*-->/m;
const FINDING_MARKER_FP_ONLY_RE = /^<!--\s*dev-loops:finding\s+([0-9a-f]{16})\b/gm;

export function parseFindingMarker(text) {
  const match = typeof text === "string" ? text.match(FINDING_MARKER_RE) : null;
  if (!match) return null;
  return {
    fp: match[1],
    severity: normalizeSeverity(match[2]),
    angle: match[3],
    round: Number(match[4]),
    operatorVisible: match[5] === "1",
    disposition: match[6] ?? null,
    issue: match[7] ? Number(match[7]) : null,
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
// files[0] is trimmed here too (readGateFindingsLedger also normalizes it)
// for any other caller of this function.
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
// Follow-up issue for deferred findings (GATE-EXEC-DEFERRAL-RECORD)
// ---------------------------------------------------------------------------
//
// A `defer` disposition (judge-pass.mjs's relevance defer, or
// close-gate-findings.mjs's severity/round auto-defer) always creates or
// appends to ONE tracked GitHub issue per PR — batched, never one issue per
// finding. `existingIssueNumber`, when the caller already knows one, is
// reused instead of minting a second issue.

// A finding's summary/angle is untrusted free text. Both the append path
// (guarded via commentIssue's guardCommentBodyNoIssuePrIds) and the create
// path (unguarded) render through formatDeferredFindingEntry, which strips a
// literal leading `#` off a bare digit token rather than entity-encoding it:
// entity-encoding still decodes back to a bare `#` immediately followed by digits under the guard's own
// decode-aware scan, but stripping the `#` means no decode path can ever
// reassemble one, and it makes GitHub's own auto-linker a non-issue too
// (auto-link syntax requires the leading `#`). Both paths render through
// this one function, so they stay guard-safe symmetrically by construction.
//
// ponytail: this strips only a literal `#` before digits, not the guard's
// full HTML-entity decode surface (e.g. `&num;123`). That input is
// unreachable from reviewer-authored finding prose; if it ever occurs the
// guard still fail-closes the defer pass rather than leaking silently.
//
// Runs on the RAW summary/angle text, before sanitizeInline/sanitizeCodeSpan
// (which emit their own numeric character references that a bare-id strip
// would corrupt) — see neutralizeBareIssuePrIds in
// @dev-loops/core/github/comment-id-guard, the shared implementation this
// and the fan-in consolidation seam both use.

function formatDeferredFindingEntry({ fingerprint, severity, angle, summary, refUrl }) {
  const detail = typeof summary === "string" && summary.trim().length > 0
    ? sanitizeInline(neutralizeBareIssuePrIds(summary.trim()))
    : (typeof refUrl === "string" && refUrl.trim().length > 0
      ? neutralizeBareIssuePrIds(refUrl.trim())
      : "(no summary recorded)");
  const safeAngle = sanitizeCodeSpan(neutralizeBareIssuePrIds(angle));
  return `- \`${sanitizeCodeSpan(fingerprint)}\` **${sanitizeInline(normalizeSeverity(severity))}** (\`${safeAngle}\`): ${detail}`;
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
 * Resolve the PR's ONE tracked follow-up issue via GitHub search, not a
 * caller's own local cache: judge-pass.mjs and close-gate-findings.mjs each
 * cache the link in a disjoint local store, so only GitHub is shared between
 * them. Requires an EXACT title match against `buildFollowUpIssueTitle`
 * (gh's `--search` is fuzzy, so a substring/reordered-word hit must not
 * count). Returns the lowest matching issue number, or `null` if none exists.
 */
export async function findFollowUpIssueOnGitHub(
  { repo, pr },
  { env = process.env, ghCommand = "gh", run = defaultRunChild, listIssues = coreListIssues } = {},
) {
  const title = buildFollowUpIssueTitle({ repo, pr });
  const { issues } = await listIssues(
    { repo, state: "open", search: `"${title}" in:title`, limit: 10 },
    { env, ghCommand, run },
  );
  const matches = issues.filter((issue) => issue.title === title).map((issue) => issue.number);
  return matches.length > 0 ? Math.min(...matches) : null;
}

/**
 * Create (or, when `existingIssueNumber` is already known, append a comment
 * to) the ONE tracked follow-up issue for a batch of `defer`-disposed
 * findings on one PR. Returns `{ issueNumber, created }`. Dependencies
 * default to the sanctioned core wrappers (`@dev-loops/core/github/issue-ops`,
 * never a raw `gh` call) and are injectable for tests. An absent
 * `existingIssueNumber` resolves against GitHub itself
 * (`findFollowUpIssueOnGitHub`) before creating, rather than assuming no
 * issue exists yet.
 *
 * ponytail: a crash between `createIssue` returning and the caller
 * persisting its own link no longer orphans a duplicate — retry's
 * search-before-create finds it on GitHub and appends instead. Residual
 * risk: GitHub search's own indexing lag on an immediate retry.
 */
export async function ensureFollowUpIssue(
  { repo, pr, entries, existingIssueNumber },
  { env = process.env, ghCommand = "gh", run = defaultRunChild, createIssue = coreCreateIssue, commentIssue = coreCommentIssue, listIssues = coreListIssues } = {},
) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("ensureFollowUpIssue: entries must be a non-empty array");
  }
  const resolvedIssueNumber = Number.isInteger(existingIssueNumber) && existingIssueNumber > 0
    ? existingIssueNumber
    : await findFollowUpIssueOnGitHub({ repo, pr }, { env, ghCommand, run, listIssues });
  if (resolvedIssueNumber !== null) {
    await commentIssue(
      { repo, issue: resolvedIssueNumber, body: buildFollowUpIssueAppendComment({ entries }) },
      { env, ghCommand, run },
    );
    return { issueNumber: resolvedIssueNumber, created: false };
  }
  // commentIssue (append path, above) runs guardCommentBodyNoIssuePrIds
  // internally; createIssue does not. Guard the create body explicitly here
  // too, on top of (never instead of) formatDeferredFindingEntry's own
  // guard-safe rendering, so a future rendering regression fails closed on
  // both paths identically.
  const createBody = buildFollowUpIssueBody({ repo, pr, entries });
  guardCommentBodyNoIssuePrIds(createBody, { ref: "follow-up issue body" });
  const result = await createIssue(
    { repo, title: buildFollowUpIssueTitle({ repo, pr }), body: createBody },
    { env, ghCommand, run },
  );
  return { issueNumber: result.issueNumber, created: true };
}

// ---------------------------------------------------------------------------
// Rendering (finding lines, inline comments, body-filed blocks)
// ---------------------------------------------------------------------------

// One deterministic, round-trip-parseable line rendering severity/angle/
// summary, shared by inline comments (unblockquoted) and body-filed blocks
// (blockquoted by the caller). `severity` is normalized (legacy spelling
// renders under its canonical name) AND sanitized with sanitizeInline, not
// sanitizeCodeSpan: it renders bare ("**${severity}**", not in a code span),
// and sanitizing it also blocks a newline from escaping the blockquote a
// body-filed block relies on (see renderNonLocatableBlock). angle keeps
// sanitizeCodeSpan (it is in a code span); summary already uses
// sanitizeInline. normalizeSeverity alone does not neutralize hostile
// characters, so it is applied in addition to, never instead of,
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
  // Carry the finding's own explicit operator-visibility signal onto the
  // marker (`ov=1` when `finding.operatorVisible === true`); anything else
  // renders no field, the conservative default isFileableDeferral treats as
  // NOT operator visible.
  const lines = [
    buildFindingMarker({ fp, severity, angle: finding.angle, round, operatorVisible: finding.operatorVisible === true }),
    renderFindingLine({ ...finding, severity }),
  ];
  if (hasRecommendation(finding)) {
    lines.push(renderRecommendationLine(finding.recommendation));
  }
  return sanitizeCopilotSummonTokens(lines.join("\n"));
}

// Every content line after the marker is blockquoted: load-bearing. The
// evidence checker's marker parser strips markdown headers/bold but not a
// leading "> ", so no finding line can ever match its own line-start
// gate:/head sha:/verdict:/summary: field regex — these blocks share a body
// with the genuine verdict fields.
//
// A body-filed finding never gets a resolvable thread (it lives in a review
// body, not a review comment), so it never gets the threaded medium
// finding's round<=3 in-gate fix window. It is therefore deferred BY
// CONSTRUCTION at render time, regardless of round: every non-high severity
// (medium, low, nit, and question — a question also has no thread to answer
// through here) is stamped disposition=deferred the moment it is posted.
// high stays unstamped (a clean verdict blocks on it; it is never body-filed
// as an accepted outcome). This keeps the finding from being suppressed by
// its own fingerprint while tracked nowhere else.
//
// buildNonLocatableFindingMarker is factored out on its own (GATE-COMMENT-SINGLE-SURFACE):
// upsert-checkpoint-verdict.mjs's grouped findings table is now the sole
// VISIBLE carrier of a body-filed finding's text, but this invisible
// marker's fingerprint+disposition=deferred stamp is still load-bearing for
// GATE-EXEC-FINDING-THREADS (collectSuppressedFingerprints, and
// isFileableDeferral/isDeferredAtRound's follow-up-issue tracking, all read
// it back off the posted review body) — removing the now-redundant
// human-readable duplicate must never also drop this marker.
export function buildNonLocatableFindingMarker(finding, { round }) {
  const fp = fingerprintFinding(finding);
  // Normalized ONCE and reused for both the disposition decision and the
  // marker: deciding disposition off a raw, un-normalized legacy spelling
  // would misclassify it (e.g. "must-fix" !== "high").
  const severity = /** @type {string} */ (normalizeSeverity(finding.severity));
  const disposition = severity === "high" ? undefined : "deferred";
  return buildFindingMarker({ fp, severity, angle: finding.angle, round, disposition });
}

// Human-readable rendering of a body-filed finding, kept for callers that
// still want the full blockquoted block (e.g. this module's own tests) — no
// longer spliced into the posted verdict body itself (upsert-checkpoint-verdict.mjs
// splices buildNonLocatableFindingMarker alone; see its own doc for why).
export function renderNonLocatableBlock(finding, { round }) {
  // renderFindingLine below normalizes AND sanitizes severity again on its
  // own; that sanitizeInline call, not this outer normalize, is what keeps a
  // hostile (e.g. newline-bearing) severity out of the posted body.
  const severity = /** @type {string} */ (normalizeSeverity(finding.severity));
  const lines = [
    buildNonLocatableFindingMarker(finding, { round }),
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
  return commentableSet.has(`${resolveFindingFile(finding)}:${finding.line}`);
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
  // as absent (GATE-COMMENT-VERDICT-VALUES): a malformed `overallVerdict` must not let a contradicting
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
    // The operator-visibility signal (see buildFindingMarker's own doc) is
    // optional, boolean-only. A malformed value fails closed here instead of
    // silently coercing to falsy, so a producer's typo is a ledger-write
    // error, not a silently over-broad "resolved, not filed" default.
    if ("operatorVisible" in f && f.operatorVisible !== undefined && typeof f.operatorVisible !== "boolean") {
      throw fail(`Gate findings ledger "${ledgerPath}" findings[${i}].operatorVisible must be a boolean`);
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
  // validates it at write time via provenanceConsistencyError, only when
  // written with --provenance); a reader that needs to trust it (e.g.
  // upsert-checkpoint-verdict.mjs's withheld-tier mandatory-angle check)
  // re-validates with the same function rather than assuming a hand-edited
  // or shadow ledger is honest.
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
 * round's single visible surface today). The reviews read is FAIL-OPEN (a
 * legacy issue-comment verdict still validates on its own); the issue-comment
 * read stays fail-closed.
 *
 * When `reportSurfaces` is set, the caller gets back `{ comments, surfaces }`
 * listing exactly the surfaces successfully read — never a review surface
 * whose gh read failed — so an audit consumer never overclaims a silently
 * failed review read, while every other caller keeps the fail-open default.
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
 * `dev-loops:finding` marker (any severity). This is the gate-close predicate
 * (GATE-EXEC-FINDING-THREADS) fetchDraftGateEvidence wires in: a clean verdict alone no longer
 * satisfies the gate — every gate-authored thread must be resolved
 * (fix-closed by the fixer, or defer-closed by the disposition pass) first.
 *
 * When `login` is `null`, the author-identity check is skipped and the count
 * is MARKER-ONLY (any unresolved thread carrying a finding marker) — a
 * deliberately fail-closed proxy: a foreign comment quoting a real marker
 * over-counts and blocks (safe) rather than under-counting and proceeding.
 * The disposition pass uses author identity because it MUTATES threads
 * (forgery matters there); this read-only counter accepts the marker-only
 * fallback so a caller without a resolved login can still assert the
 * gate-close invariant without an extra `api user` round-trip.
 *
 * `threads` is the shape `fetchAllReviewThreads` (list-review-threads.mjs)
 * returns: `{ author, body, isResolved, ... }`.
 */
export function countUnresolvedGateAuthoredThreads(threads, login) {
  // A non-array `threads` is a caller contract violation; the fail-closed
  // posture is to THROW (callers treat the unreadable state as -1/blocked)
  // rather than silently coerce to [] and under-count dangling threads.
  if (!Array.isArray(threads)) {
    throw new Error(`countUnresolvedGateAuthoredThreads: threads must be an array, got ${typeof threads}`);
  }
  // Any falsy login (null/undefined/"") falls back to the MARKER-ONLY proxy —
  // it must over-count and block (fail-closed), never silently skip threads.
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
  // A non-array `rawNodes` is a caller contract violation; fail CLOSED — let
  // the TypeError propagate (detect-checkpoint-evidence sets
  // unresolvedGateThreadCount = -1/blocked) rather than silently coerce to
  // [] and under-count.
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
 * A clean verdict alone is not sufficient (see countUnresolvedGateAuthoredThreads):
 * the gate-close assertion here also refuses ready-for-review while any
 * gate-authored thread still dangles. `unresolvedGateThreadCount` is
 * fail-closed (-1) when the thread/login state cannot be read.
 */
export async function fetchDraftGateEvidence({ repo, pr, headSha }, gh) {
  const comments = await fetchGateEvidenceComments({ repo, pr }, gh);
  const summary = summarizeGateReviewComments(comments).draft_gate;
  const marker = summarizeGateReviewCommentMarkers(comments, { headSha }).draft_gate;
  const draftGate = summary ? { ...summary, visible: true } : { visible: false };
  const draftGateMarker = marker
    ? { ...marker, visible: true, contractComplete: marker.contractComplete === true }
    : { visible: false, contractComplete: false };
  // The verdict-clean flags below stay VERDICT-ONLY so a verdict/head mismatch
  // is reported distinctly from an unresolved-thread mismatch; the
  // unresolved-gate-authored-thread count is a SEPARATE field the callers
  // (pre-pr-ready-gate / ready-for-review) assert alongside it. Fail-closed
  // (-1) when the thread/login state is unreadable: the
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
 *
 * `event` defaults to "COMMENT" (draft_gate/pre_approval_gate's only submit
 * mode — GATE-COMMENT-SINGLE-SURFACE). The standalone `review` gate's
 * `pending` submit mode (GATE-REVIEW-SUBMIT-MODES) passes `event: null` so GitHub leaves the
 * review PENDING (author-only draft): a falsy `event` here — `null`, never
 * the parameter-default-triggering `undefined` — omits the `event` key from
 * the payload entirely, which is what the create-review API reads as "leave
 * pending" rather than submitting it.
 */
export async function createGateReview({ repo, pr, headSha, body, comments, allowedRefs, event = "COMMENT" }, { env, ghCommand, runChild = defaultRunChild }) {
  // ISSUE/PR-ID GUARD: refuse a verdict body or inline finding comment
  // that emits a raw issue/PR id (fail-closed) unless explicitly allowlisted.
  guardCommentBodyNoIssuePrIds(body, { ref: "gate verdict comment body", allowedRefs });
  for (const comment of comments ?? []) {
    guardCommentBodyNoIssuePrIds(comment?.body, { ref: "gate review inline finding comment", allowedRefs });
  }
  const payload = { commit_id: headSha, body, comments, ...(event ? { event } : {}) };
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

/**
 * Find the authenticated caller's own PENDING (author-only draft) review on
 * this PR. GitHub allows only ONE pending review per user per PR (PR-scoped,
 * not head-scoped), so ANY create 422s while one exists on whatever head
 * (GATE-REVIEW-SUBMIT-MODES): a `--gate review --submit` re-run must resolve it first (submit
 * via `submitPendingReview`, or delete it) rather than POST a second one. A
 * pending review is author-only, so its marker is never `visible` — this
 * reads the raw reviews list instead.
 *
 * No author-identity check is needed (GitHub lists a PENDING review only to
 * its own author), but "the caller's own" is not the same as "this tool's
 * own": the token may have a MANUAL pending draft from the GitHub UI.
 * Submitting or deleting that would be data loss, so this fails closed to a
 * dev-loops draft — only a pending review whose body carries the
 * `### Gate review: \`review\`` header (REVIEW_GATE_PENDING_HEADER_RE) is
 * treated as resolvable; a foreign/manual draft is reported as absent and
 * left untouched. The returned `sameHead` flag reports whether the pending
 * review's `commit_id` matches this round's head, so the caller can submit a
 * same-head pending as-is but clear a stale one before creating fresh (a
 * stale pending left in place would 422 the create). Returns
 * `{ id, commitId, body, sameHead }` or `null`.
 */
// Anchored to the START of the body (no `m` flag): a foreign draft that
// merely quotes the header line lower down must never match (GATE-REVIEW-SUBMIT-MODES).
// GATE_REVIEW_COMMENT_HEADER_RE (core) is scoped to draft_gate/
// pre_approval_gate only, so `review`'s own header is matched locally here.
const REVIEW_GATE_PENDING_HEADER_RE = /^###[ \t]+Gate review:[ \t]*`review`[ \t]*(?:\r?\n|$)/;

export async function findOwnPendingReview({ repo, pr, headSha }, { env, ghCommand, runChild = defaultRunChild }) {
  const payload = await runGhJson(prReviewsApiArgs(repo, pr), { env, ghCommand, runChild });
  const match = flattenPaginatedSlurp(payload).find((r) =>
    r?.state === "PENDING"
    && Number.isInteger(r?.id)
    && REVIEW_GATE_PENDING_HEADER_RE.test(typeof r?.body === "string" ? r.body : ""),
  );
  if (!match) return null;
  const commitId = typeof match.commit_id === "string" ? match.commit_id : null;
  return {
    id: match.id,
    commitId,
    body: typeof match.body === "string" ? match.body : "",
    sameHead: commitId !== null && commitId === headSha,
  };
}

/**
 * Find the caller's OWN same-head SUBMITTED review-gate review — the round's
 * existing surface for a `--gate review` rerun. Sibling of findOwnPendingReview
 * for the submitted (no longer PENDING) case: once submitted a review is no
 * longer PENDING, so findOwnPendingReview stops seeing it and a naive rerun
 * would POST a duplicate. Matches only a review whose `state` is not PENDING,
 * whose `commit_id` equals this round's head, and whose body opens with the
 * `### Gate review: \`review\`` header (REVIEW_GATE_PENDING_HEADER_RE).
 *
 * Author identity is REQUIRED here (unlike findOwnPendingReview): GitHub lists
 * EVERY submitted review, not only the caller's own, so a foreign author's
 * same-head review-gate review must never be treated as this tool's surface.
 * The `api user` login read is deferred until a header/head candidate exists,
 * so the common create path (no prior review) pays only the reviews list read.
 * Returns `{ id, body, commentUrl }` or `null`.
 */
export async function findOwnSubmittedReview({ repo, pr, headSha }, gh) {
  const payload = await runGhJson(prReviewsApiArgs(repo, pr), gh);
  const candidates = flattenPaginatedSlurp(payload).filter((r) =>
    r?.state !== "PENDING"
    && Number.isInteger(r?.id)
    && typeof r?.commit_id === "string"
    && r.commit_id === headSha
    && REVIEW_GATE_PENDING_HEADER_RE.test(typeof r?.body === "string" ? r.body : ""),
  );
  if (candidates.length === 0) return null;
  const login = await resolveAuthenticatedLogin(gh);
  const own = candidates.find((r) =>
    typeof r?.user?.login === "string" && r.user.login.length > 0 && r.user.login === login,
  );
  if (!own) return null;
  return {
    id: own.id,
    body: typeof own.body === "string" ? own.body : "",
    commentUrl: typeof own.html_url === "string" && own.html_url.trim().length > 0 ? own.html_url.trim() : null,
  };
}

/**
 * Submit an existing PENDING review via
 * `POST /repos/<owner>/<repo>/pulls/<pr>/reviews/<id>/events`, mapping the
 * review-gate submit mode's event (`COMMENT` | `REQUEST_CHANGES` | `APPROVE`).
 * This preserves the pending review's already-attached inline comments — the
 * events endpoint submits the draft as-is; only the event (and an optional body
 * override) are sent. Distinct from `createGateReview`, which would 422 when a
 * pending review already exists (GATE-REVIEW-SUBMIT-MODES).
 */
export async function submitPendingReview({ repo, pr, reviewId, event, body }, { env, ghCommand, runChild = defaultRunChild }) {
  const payload = { event, ...(typeof body === "string" && body.length > 0 ? { body } : {}) };
  const result = await runChild(
    ghCommand,
    ["api", "-X", "POST", `repos/${repo}/pulls/${pr}/reviews/${reviewId}/events`, "--input", "-"],
    env,
    `${JSON.stringify(payload)}\n`,
  );
  assertGhSuccess(result);
  return parseReviewMutationResponse(parseJsonText(result.stdout, { label: "gh api pulls reviews events (POST)" }));
}

/**
 * Delete an existing PENDING review via
 * `DELETE /repos/<owner>/<repo>/pulls/<pr>/reviews/<id>` — the "Discard" submit
 * choice (GATE-REVIEW-SUBMIT-MODES), distinct from "Leave pending" which leaves the draft in
 * place. Only ever called on the caller's OWN pending review (resolved via
 * `findOwnPendingReview`).
 */
export async function discardPendingReview({ repo, pr, reviewId }, { env, ghCommand, runChild = defaultRunChild }) {
  const result = await runChild(
    ghCommand,
    ["api", "-X", "DELETE", `repos/${repo}/pulls/${pr}/reviews/${reviewId}`],
    env,
  );
  assertGhSuccess(result);
  return { reviewId };
}

// ---------------------------------------------------------------------------
// Round determination
// ---------------------------------------------------------------------------

// A genuine gate verdict surface always carries upsert-checkpoint-verdict.mjs's
// own render header ("### Gate review: `<gate>`") — a literal shape no other
// machine-authored gate artifact renders. Matching that (matchGateReviewCommentHeader),
// rather than the lenient field parser, is what keeps this count scoped to
// real verdicts; it is line-start anchored, so a quoted header in a reply
// can't count.
//
// Round source (A) is the SIZE of the SET of distinct reviewed-head SHAs
// (the literal "**Reviewed head SHA:**" line) collected across BOTH the
// PR-review and issue-comment streams, never an additive raw count: a
// verdict for the SAME head can exist on both streams (the sanctioned
// producer posts reviews; historical/hand-posted verdicts live on issue
// comments), so deduping by head means duplication can never inflate the
// round and end the medium fix window early.
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

// Scoped strictly to review bodies carrying THIS gate's own header marker —
// never mixes draft_gate/pre_approval_gate round numbers. Only the header's
// own round= is read: an inline-comment finding marker never appears in a
// review BODY at all (only in the separate review comment GitHub attaches
// it to), so scanning finding markers here could never find a round the
// header does not already carry.
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

// list-review-threads.mjs's fetchAllReviewThreads excerpts each thread's
// first-comment body to a bounded length for cheap listing. Every decision
// made off a thread body (marker parsing, disposition, suppression) needs
// the UNTRUNCATED body, so join the listing with captureParsedReviewThreads'
// full first-comment text, keyed on the shared comment databaseId. The two
// are INDEPENDENT paginated GraphQL walks, so a thread present in one and
// absent from the other (created/cursor-shifted between them) must fail
// closed on a join miss rather than silently fall back to a possibly
// mid-marker-truncated excerpt. The excerpt is self-identifying (a trailing
// U+2026 is appended only when truncation actually occurred), so a join
// miss only fails when the listing body is ALSO over BODY_EXCERPT_MAX_CHARS
// and ends with that ellipsis — a short body legitimately ending in its own
// "…" never needed truncation and is already complete.
const BODY_EXCERPT_ELLIPSIS = "…";

// Only a non-empty string body is a usable join hit: a comment whose
// databaseId resolves but whose body is missing/empty must not blank a
// thread's real listing excerpt — "" would drop the thread out of marker
// parsing, disposition, and suppression with no signal at all, which is
// strictly worse than a join miss (falls through to the truncation check).
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
