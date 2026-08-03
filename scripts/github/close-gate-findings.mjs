#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { formatCliError, isDirectCliRun, parseJsonText, sanitizeCopilotSummonTokens } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { normalizeFullHeadSha } from "../lib/head-sha.mjs";
import { commentIssue } from "./comment-issue.mjs";
import {
  findMarkedComment,
  flattenPaginatedSlurp,
  listIssueComments,
  runGhJson,
  sanitizeCodeSpan,
  sanitizeInline,
  updateComment,
} from "./post-gate-findings.mjs";
import { matchGateReviewCommentHeader } from "./upsert-checkpoint-verdict.mjs";
import { buildLogPath } from "./write-gate-findings-log.mjs";
import { BODY_EXCERPT_MAX_CHARS, fetchAllReviewThreads } from "./list-review-threads.mjs";
import { captureParsedReviewThreads, replyAndMaybeResolve, runChildWithInput } from "./_review-thread-mutations.mjs";

const USAGE = `Usage: close-gate-findings.mjs --ledger <findings-log path> [--tmp-root <dir>]
Post a closed gate round's findings (write-gate-findings-log.mjs ledger) as ONE PR
review of type COMMENT: a locatable (files[0]+line, in-diff) finding becomes an
inline comment; everything else goes in the review body. Candidates already
covered by an existing review thread or review body (fingerprint match, resolved
threads included) are dropped before posting. Then a disposition pass reconciles
every unresolved gate-authored thread against the current round: must-fix always
stays open; worth-fixing-now stays open through round 3 of this gate's chain and
is replied-to + resolved ("deferred at gate close") from round 4; defer-severity
is replied-to + resolved immediately. Finally, on a pre_approval_gate round whose
ledger verdict is clean and that closes with zero unresolved gate-authored
threads, a single combined PR comment summarizing every deferred finding is
created (or updated in place on a later run); a trigger with zero deferred
findings and no pre-existing summary comment posts nothing.

Round number = the MAXIMUM of three worktree-independent-first sources:
  (A) count of DISTINCT reviewed-head SHAs across this gate's own verdict comments —
      issue comments (repos/.../issues/.../comments, the same history
      detect-checkpoint-evidence reads) plus any verdict-headed PR review body
      (repos/.../pulls/.../reviews) — deduped so the same head's verdict landing on
      both surfaces counts once, current round's own verdict comment already posted
      by the time this runs;
  (B) the highest round= recorded on this gate's own posted review headers (the
      "gate-findings-review <gate>" marker, so it can never mix rounds across gates);
  (C) count of local <gate>-*.json findings-log files under --tmp-root/gate-findings/....
(A) is primary and survives a fresh worktree/clone; (B) and (C) are cross-checks that
can only push the round number UP, never down, guarding against an undercount.

Required:
  --ledger <path>              Path to a write-gate-findings-log.mjs JSON ledger:
                                { repo, pr, gate, headSha, verdict, findings[] }
                                repo/pr/gate/headSha/verdict are derived from the ledger itself.
Optional:
  --tmp-root <path>            Root tmp directory for the local findings-log fallback
                                count (default: tmp/)

Output (stdout, JSON):
  { "ok": true, "gate": "...", "headSha": "...", "round": N,
    "posted": <inline comment count>, "bodyFiled": <non-locatable finding count>,
    "suppressed": <dedupe-dropped count>, "deferredResolved": <disposition reply+resolve count>,
    "summary": "created"|"updated"|"no_deferred_findings"|"not_triggered" }

${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error or gh failure
  2  Invalid --jq filter`.trim();

function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

const VALID_SEVERITIES = new Set(["must-fix", "worth-fixing-now", "defer"]);
const VALID_VERDICTS = new Set(["clean", "findings_present", "blocked"]);
const VALID_GATES = new Set(["draft_gate", "pre_approval_gate"]);
// Findings at round <= this stay in the standard fix loop; from the next round
// on, an open worth-fixing-now finding is deferred instead of re-fixed in-gate.
const WORTH_FIXING_NOW_FIX_WINDOW = 3;
const DEFERRED_SUMMARY_MARKER = "<!-- dev-loops:deferred-summary -->";

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
// disposed as deferred: must-fix never defers; worth-fixing-now defers only
// once the chain is past the in-gate fix window; defer always defers
// immediately. Governs the THREAD disposition pass (selectDispositionTargets)
// ONLY — a locatable finding's round-gated fix window, decided through its own
// resolvable review thread. Body-filed finding rendering (renderNonLocatableBlock)
// deliberately does NOT call this: a body-filed finding never gets a thread to
// fix through, so it is stamped deferred unconditionally at render time,
// regardless of round (see that function's own comment).
function isDeferredAtRound(severity, round) {
  if (severity === "must-fix") return false;
  if (severity === "worth-fixing-now") return round > WORTH_FIXING_NOW_FIX_WINDOW;
  return true; // "defer"
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

export function buildFindingMarker({ fp, severity, angle, round, disposition }) {
  if (disposition !== undefined && !VALID_MARKER_DISPOSITIONS.has(disposition)) {
    throw new Error(`buildFindingMarker: disposition must be "deferred" (or omitted), got ${JSON.stringify(disposition)}`);
  }
  const dispositionField = disposition ? ` disposition=${slugForMarker(disposition)}` : "";
  return `<!-- dev-loops:finding ${fp} severity=${slugForMarker(severity)} angle=${slugForMarker(angle)} round=${round}${dispositionField} -->`;
}

// Anchored to the START of a line (multiline `m`): a marker quoted mid-line
// inside a finding's own free text (e.g. a recommendation that pastes a prior
// marker as an example) must never be honored as a real marker. Every marker
// this module renders is always the first character of its own line, so this
// anchor costs nothing against genuine markers.
const FINDING_MARKER_RE = /^<!--\s*dev-loops:finding\s+([0-9a-f]{16})\s+severity=([a-z0-9._-]+)\s+angle=([a-z0-9._-]+)\s+round=(\d+)(?:\s+disposition=(deferred))?\s*-->/m;
const FINDING_MARKER_FP_ONLY_RE = /^<!--\s*dev-loops:finding\s+([0-9a-f]{16})\b/gm;

export function parseFindingMarker(text) {
  const match = typeof text === "string" ? text.match(FINDING_MARKER_RE) : null;
  if (!match) return null;
  return { fp: match[1], severity: match[2], angle: match[3], round: Number(match[4]), disposition: match[5] ?? null };
}

// Round is embedded here (an addition beyond the finding marker's own round=,
// which cannot be reliably attributed back to one gate without a second
// network round-trip) so the round cross-check can be computed from review
// bodies alone, correctly scoped to THIS gate.
function buildReviewHeaderMarker({ gate, headSha, round }) {
  return `<!-- dev-loops:gate-findings-review ${gate} ${headSha} round=${round} -->`;
}

// Line-start anchored (see FINDING_MARKER_RE): the header this module renders
// is always the second line of its own review body, never quoted mid-line.
const REVIEW_HEADER_RE = /^<!--\s*dev-loops:gate-findings-review\s+(draft_gate|pre_approval_gate)\s+([0-9a-f]{7,64})\s+round=(\d+)\s*-->/m;

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

// 16-hex sha256 over path + normalized summary. Line is deliberately excluded
// (it drifts across heads); angle/severity are excluded (a cross-gate or
// cross-severity re-raise of the same underlying finding must still dedupe).
// files[0] is trimmed: the two ledger writers disagree on whether a file entry
// is pre-trimmed (readLedger below normalizes it too, but this is cheap
// belt-and-braces consistency for any other caller of this exported function).
export function fingerprintFinding(finding) {
  const filePath = Array.isArray(finding.files) && finding.files.length > 0 ? String(finding.files[0]).trim() : "";
  const normalizedSummary = String(finding.summary).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return createHash("sha256").update(`${filePath}|${normalizedSummary}`).digest("hex").slice(0, 16);
}

function collectFingerprints(text, set) {
  if (typeof text !== "string") return;
  for (const match of text.matchAll(FINDING_MARKER_FP_ONLY_RE)) {
    set.add(match[1]);
  }
}

// ---------------------------------------------------------------------------
// Rendering (prose lines, findings)
// ---------------------------------------------------------------------------

// One deterministic, round-trip-parseable line rendering a finding's
// severity/angle/summary. Shared by inline comments (unblockquoted — inline
// review comments are never scanned by the evidence checker) and non-locatable
// review-body blocks (blockquoted by the caller).
function renderFindingLine({ severity, angle, summary }) {
  return `**${severity}** (\`${sanitizeCodeSpan(angle)}\`): ${sanitizeInline(summary)}`;
}

const FINDING_LINE_RE = /^\*\*(.+?)\*\*\s*\(`([^`]*)`\):\s*(.*)$/;

function parseFindingLine(rawLine) {
  if (typeof rawLine !== "string") return null;
  const line = rawLine.replace(/^>\s?/, "").trim();
  const match = line.match(FINDING_LINE_RE);
  if (!match) return null;
  return { severity: match[1], angle: match[2], summary: match[3] };
}

function renderRecommendationLine(recommendation) {
  return `Recommendation: ${sanitizeInline(recommendation)}`;
}

function hasRecommendation(finding) {
  return typeof finding.recommendation === "string" && finding.recommendation.trim().length > 0;
}

export function renderInlineCommentBody(finding, { round }) {
  const fp = fingerprintFinding(finding);
  const lines = [
    buildFindingMarker({ fp, severity: finding.severity, angle: finding.angle, round }),
    renderFindingLine(finding),
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
// text is worded.
//
// A body-filed finding never gets a resolvable thread (it lives in a review
// body, not a review comment) and so never passes through the thread
// disposition pass (which is where a THREADED worth-fixing-now finding gets
// its round<=3 in-gate fix window before deferring). A body-filed finding has
// no such window to begin with — there is no thread to fix it through — so it
// is deferred BY CONSTRUCTION, at render time, regardless of round: every
// non-must-fix severity (worth-fixing-now, defer) is stamped
// disposition=deferred the moment it is posted. must-fix stays unstamped
// (the ledger blocks a clean verdict on it; it is never body-filed as an
// accepted outcome). This is what keeps the finding from being suppressed by
// its own fingerprint (fingerprintFinding, matched back on a later run via
// collectFingerprints) while tracked nowhere else (fingerprint suppression +
// zero surface = permanent silent loss).
function renderNonLocatableBlock(finding, { round }) {
  const fp = fingerprintFinding(finding);
  const disposition = finding.severity === "must-fix" ? undefined : "deferred";
  const lines = [
    buildFindingMarker({ fp, severity: finding.severity, angle: finding.angle, round, disposition }),
    `> ${renderFindingLine(finding)}`,
  ];
  if (hasRecommendation(finding)) {
    lines.push(`> ${renderRecommendationLine(finding.recommendation)}`);
  }
  if (Array.isArray(finding.files) && finding.files.length > 0) {
    const refs = finding.files.map((f) => `\`${sanitizeCodeSpan(f)}\``).join(", ");
    lines.push(`> Location: ${refs}`);
  }
  return lines.join("\n");
}

// Always non-empty (the header line is unconditional): GitHub's Create-a-review
// endpoint 422s a COMMENT-event review with an empty body, so a round where
// every finding is locatable must still render a real body.
export function renderReviewBody({ gate, headSha, round, nonLocatable }) {
  const shortSha = headSha.slice(0, 7);
  const lines = [
    `Gate findings — ${gate} round ${round} @ ${shortSha}`,
    buildReviewHeaderMarker({ gate, headSha, round }),
  ];
  if (nonLocatable.length === 0) {
    lines.push("", "No out-of-diff findings this round.");
  } else {
    for (const finding of nonLocatable) {
      lines.push("", renderNonLocatableBlock(finding, { round }));
    }
  }
  return sanitizeCopilotSummonTokens(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Table-cell sanitization
// ---------------------------------------------------------------------------

// Entity-encode a table cell: sanitizeCodeSpan neutralizes embedded
// HTML-comment delimiters/backticks; `|` is additionally entity-encoded
// (never backslash-escaped — a backslash-escape is itself a bypass vector for
// the next consumer) so a finding field can never break out of its table cell.
function sanitizeCell(value) {
  return sanitizeCodeSpan(value).replace(/\|/g, "&#124;");
}

const SUMMARY_SEVERITY_ORDER = ["worth-fixing-now", "defer"];

// Full total order: severity rank, then angle, summary, location, round,
// thread URL, and finally the fingerprint — every field a row can differ on —
// so two rows can never tie and leave rendering order to insertion order
// (GitHub's pagination order), which would rewrite the upserted comment on a
// later run with no underlying state change.
export function sortSummaryRows(rows) {
  return [...rows].sort((a, b) => {
    const rankA = SUMMARY_SEVERITY_ORDER.indexOf(a.severity);
    const rankB = SUMMARY_SEVERITY_ORDER.indexOf(b.severity);
    if (rankA !== rankB) return rankA - rankB;
    if (a.angle !== b.angle) return a.angle < b.angle ? -1 : 1;
    if (a.summary !== b.summary) return a.summary < b.summary ? -1 : 1;
    if (a.location !== b.location) return a.location < b.location ? -1 : 1;
    if (a.round !== b.round) return a.round - b.round;
    const urlA = a.threadUrl ?? "";
    const urlB = b.threadUrl ?? "";
    if (urlA !== urlB) return urlA < urlB ? -1 : 1;
    const fpA = a.fingerprint ?? "";
    const fpB = b.fingerprint ?? "";
    if (fpA !== fpB) return fpA < fpB ? -1 : 1;
    return 0;
  });
}

// row.threadUrl is an ABSOLUTE https://github.com/... URL (built by the row
// builders, which have repo/pr in scope) so the link resolves from anywhere
// this comment body is rendered (notification email, `gh pr view`, a mirrored
// surface) — not only the PR conversation page a bare `#fragment` href depends
// on. row.threadLabel is the short display text (e.g. `#discussion_r123`).
export function renderDeferredSummaryBody({ pr, rows }) {
  const lines = [
    DEFERRED_SUMMARY_MARKER,
    `### Deferred gate findings — PR #${pr}`,
    "",
    "| Severity | Angle | Summary | Location | Round | Thread |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  if (rows.length === 0) {
    lines.push("| — | — | No deferred findings. | — | — | — |");
  } else {
    for (const row of sortSummaryRows(rows)) {
      const threadCell = row.threadUrl ? `[${sanitizeCell(row.threadLabel ?? row.threadUrl)}](${row.threadUrl})` : "—";
      lines.push(
        `| ${sanitizeCell(row.severity)} | ${sanitizeCell(row.angle)} | ${sanitizeCell(row.summary)} | `
        + `${row.location === "—" ? "—" : `\`${sanitizeCell(row.location)}\``} | ${row.round} | ${threadCell} |`,
      );
    }
  }
  return sanitizeCopilotSummonTokens(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Ledger read + validate
// ---------------------------------------------------------------------------

async function readLedger(ledgerPath) {
  let raw;
  try {
    raw = await readFile(ledgerPath, "utf8");
  } catch (err) {
    throw parseError(`Cannot read --ledger "${ledgerPath}": ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw parseError(`--ledger "${ledgerPath}" must contain valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw parseError(`--ledger "${ledgerPath}" must contain a JSON object`);
  }
  const { repo, pr, gate, headSha, verdict, findings } = parsed;
  let repoSlug;
  try {
    const { owner, name } = parseRepoSlug(typeof repo === "string" ? repo.trim() : repo);
    repoSlug = `${owner}/${name}`;
  } catch {
    throw parseError(`--ledger "${ledgerPath}" "repo" must be an owner/name slug`);
  }
  if (!Number.isInteger(pr) || pr <= 0) {
    throw parseError(`--ledger "${ledgerPath}" is missing a valid "pr" number`);
  }
  if (!VALID_GATES.has(gate)) {
    throw parseError(`--ledger "${ledgerPath}" "gate" must be draft_gate or pre_approval_gate`);
  }
  const fullHeadSha = normalizeFullHeadSha(headSha);
  if (fullHeadSha === null) {
    throw parseError(`--ledger "${ledgerPath}" "headSha" must be the full 40- or 64-char hex commit SHA`);
  }
  if (!VALID_VERDICTS.has(verdict)) {
    throw parseError(`--ledger "${ledgerPath}" "verdict" must be clean, findings_present, or blocked`);
  }
  if (!Array.isArray(findings)) {
    throw parseError(`--ledger "${ledgerPath}" "findings" must be an array`);
  }
  findings.forEach((f, i) => {
    if (!f || typeof f !== "object" || !VALID_SEVERITIES.has(f.severity) || typeof f.angle !== "string" || typeof f.summary !== "string") {
      throw parseError(`--ledger "${ledgerPath}" findings[${i}] is malformed (expected {severity, angle, summary})`);
    }
    if ("line" in f && f.line !== undefined && (!Number.isInteger(f.line) || f.line < 1)) {
      throw parseError(`--ledger "${ledgerPath}" findings[${i}].line must be a positive integer`);
    }
    if ("files" in f && f.files !== undefined) {
      if (!Array.isArray(f.files)) {
        throw parseError(`--ledger "${ledgerPath}" findings[${i}].files must be an array`);
      }
      f.files.forEach((entry, j) => {
        if (typeof entry !== "string" || entry.trim().length === 0) {
          throw parseError(`--ledger "${ledgerPath}" findings[${i}].files[${j}] must be a non-empty string`);
        }
      });
    }
  });
  // Trim each files[] entry so the SAME finding fingerprints identically
  // regardless of which ledger writer produced it (write-gate-findings-log.mjs
  // filters blank entries but does not trim; a hand-authored --findings path can
  // carry an untrimmed value). fingerprintFinding also trims defensively, but
  // normalizing here keeps every downstream consumer (isLocatableFinding's
  // commentable-set lookup, the posted review `path`, renderNonLocatableBlock's
  // Location line) on the same trimmed value too.
  const normalizedFindings = findings.map((f) => (
    Array.isArray(f.files) ? { ...f, files: f.files.map((entry) => entry.trim()) } : f
  ));
  return { repo: repoSlug, pr, gate, headSha: fullHeadSha, verdict, findings: normalizedFindings };
}

// ---------------------------------------------------------------------------
// gh plumbing
// ---------------------------------------------------------------------------

// Thin local wrapper over the shared stdin-piping child-process runner
// (_review-thread-mutations.mjs's runChildWithInput, reused rather than
// re-implemented here) for the calls in this module that pass no stdin.
function runChildPlain(command, args, env) {
  return runChildWithInput(command, args, env, undefined);
}

// Collapses this module's five gh-invocation exit-code checks (postReview,
// stampDeferredDisposition's GET and PATCH, plus the two read paths now
// delegated to post-gate-findings.mjs's own runGhJson) into one assertion,
// rather than five copy-pasted `if (result.code !== 0) throw ...` blocks.
function assertGhSuccess(result) {
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
}

// The authenticated `gh` viewer's login: the sole trust boundary for
// deciding whether a review/thread is gate-authored (see selectDispositionTargets
// and the suppression-folding calls in closeGateFindings below) — never
// decided from rendered marker text alone, which a foreign comment could
// forge just as easily as this module's own producer renders it.
async function resolveAuthenticatedLogin({ env, ghCommand }) {
  const payload = await runGhJson(["api", "user"], { env, ghCommand });
  const login = typeof payload?.login === "string" ? payload.login.trim() : "";
  if (login.length === 0) {
    throw new Error("gh api user returned no login; cannot verify gate-authored marker provenance — fail closed.");
  }
  return login;
}

async function listPrReviews({ repo, pr }, { env, ghCommand }) {
  const payload = await runGhJson(
    ["api", "--paginate", "--slurp", `repos/${repo}/pulls/${pr}/reviews?per_page=100`],
    { env, ghCommand },
  );
  return flattenPaginatedSlurp(payload)
    .filter((r) => r && typeof r.body === "string" && r.body.trim().length > 0)
    .map((r) => ({
      id: Number.isInteger(r.id) ? r.id : null,
      body: r.body,
      author: typeof r?.user?.login === "string" && r.user.login.length > 0 ? r.user.login : null,
    }));
}

async function fetchPrFiles({ repo, pr }, { env, ghCommand }) {
  const payload = await runGhJson(
    ["api", "--paginate", "--slurp", `repos/${repo}/pulls/${pr}/files?per_page=100`],
    { env, ghCommand },
  );
  return flattenPaginatedSlurp(payload);
}

async function postReview({ repo, pr, headSha, body, comments }, { env, ghCommand }) {
  const payload = { commit_id: headSha, event: "COMMENT", body, comments };
  const result = await runChildWithInput(
    ghCommand,
    ["api", "-X", "POST", `repos/${repo}/pulls/${pr}/reviews`, "--input", "-"],
    env,
    `${JSON.stringify(payload)}\n`,
  );
  assertGhSuccess(result);
  return parseJsonText(result.stdout, { label: "gh api pulls reviews (POST)" });
}

// ---------------------------------------------------------------------------
// Round determination
// ---------------------------------------------------------------------------

// A genuine gate verdict comment always begins with upsert-checkpoint-verdict.mjs's
// own render header ("### Gate review: `<gate>`", renderGateReviewCommentBody's
// first line) — a literal shape no other machine-authored gate artifact in this
// repo renders: post-gate-findings.mjs's findings comment ("### Gate fan-out
// findings: ..."), this module's own review header ("Gate findings — ...\n<!--
// dev-loops:gate-findings-review ... -->"), and the deferred-summary comment
// ("<!-- dev-loops:deferred-summary -->\n### Deferred gate findings ...") all
// use different literal text. Matching this instead of the LENIENT field parser
// (parseGateReviewCommentMarkerBody, which accepts a bare gate name plus any hex
// token anywhere in the body) is what keeps this count scoped to real verdict
// comments — every one of those three machine artifacts otherwise also mentions
// this gate's name and a hex SHA, and is itself posted to the PR's issue-comment
// stream. matchGateReviewCommentHeader (imported from upsert-checkpoint-verdict.mjs,
// the producer of that literal) is line-start anchored so a quoted header in a
// reply can't count, and keeps this consumer from drifting from the producer if
// the label wording ever changes.
//
// The literal "**Reviewed head SHA:** `<sha>`" line renderGateReviewCommentBody
// always renders immediately after the header identifies WHICH head a matched
// comment is evidence for. Round source (A) is the SIZE of the SET of distinct
// reviewed-head SHAs collected across BOTH the issue-comment and PR-review
// streams (collectVerdictHeadShas below), never an additive raw comment count:
// this module's own sanctioned producer (upsert-checkpoint-verdict.mjs) only
// ever posts an issue comment (createComment/updateComment, both against
// repos/{repo}/issues/{pr}/comments), and COPILOT-FOLLOWUP-GATE-COMMENT-CANONICAL
// (skills/copilot-pr-followup/SKILL.md) forbids posting a gate verdict as a
// `gh pr review`. The PR-review stream is scanned anyway, purely as defense in
// depth: detect-checkpoint-evidence.mjs's own gate-evidence read has
// historically had to merge a comments scan with a reviews scan to guard
// against a duplicate/hand-posted verdict landing there, so a verdict for the
// SAME head could in principle exist on both surfaces. Deduping by head (not
// by raw comment/review count) means that duplication can never inflate the
// round and end the worth-fixing-now fix window early. A comment/review body
// that matches the header literal but carries no parseable reviewed-head line
// contributes nothing — it cannot be a genuine verdict for any distinguishable
// head, so it must not silently count.
const REVIEWED_HEAD_SHA_RE = /^\*\*Reviewed head SHA:\*\*\s*`([0-9a-f]{7,64})`\s*$/m;

function extractReviewedHeadSha(body) {
  const match = typeof body === "string" ? body.match(REVIEWED_HEAD_SHA_RE) : null;
  return match ? match[1].toLowerCase() : null;
}

function collectVerdictHeadShas(comments, gate, headShas) {
  for (const comment of comments) {
    if (matchGateReviewCommentHeader(comment?.body) !== gate) continue;
    const headSha = extractReviewedHeadSha(comment.body);
    if (headSha) headShas.add(headSha);
  }
}

// Scoped strictly to review bodies that carry THIS gate's own header marker —
// never mixes draft_gate/pre_approval_gate round numbers together. Only the
// header's own round= is read: renderReviewBody stamps the header and every
// finding marker in that same body from the SAME `round` variable, and an
// inline-comment finding marker (a locatable finding's own thread) never
// appears in a review BODY at all — only in the separate review comment
// GitHub attaches it to — so scanning finding markers here could never find a
// round the header does not already carry.
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
  if (!Array.isArray(finding.files) || finding.files.length === 0) return false;
  if (!Number.isInteger(finding.line) || finding.line < 1) return false;
  return commentableSet.has(`${finding.files[0]}:${finding.line}`);
}

// ---------------------------------------------------------------------------
// Disposition pass
// ---------------------------------------------------------------------------

function dispositionMessage(round) {
  return `Deferred at gate close (round ${round}); filed in the deferred summary.`;
}

// Every currently-unresolved gate-authored thread, whether newly posted this
// round or carried open from an earlier one, is reconciled against the
// CURRENT round — not the round recorded on its own marker. A worth-fixing-now
// finding first raised at round 1 and still open when the chain reaches round
// 4 is deferred then, exactly like one raised fresh at round 4.
function selectDispositionTargets(threads, round, login) {
  const targets = [];
  for (const thread of threads) {
    if (thread.isResolved) continue;
    // Gate-authored is decided by AUTHOR IDENTITY (the authenticated `gh`
    // viewer's own login), never by rendered marker text alone: a foreign
    // comment can quote the exact marker shape this module renders just as
    // easily as this module's own producer does, and this function's result
    // is PATCHed (stampDeferredDisposition) and resolved — mutating a
    // third-party comment on the strength of its own words would be a forgery
    // vector, not a provenance check.
    if (thread.author !== login) continue;
    const marker = parseFindingMarker(thread.body);
    if (!marker) continue; // author matches, but carries no parseable finding marker
    if (!isDeferredAtRound(marker.severity, round)) continue;
    // commentId is null whenever list-review-threads.mjs could not resolve a
    // finite databaseId for the thread's first comment. Reject it here, named
    // by threadId, rather than let it reach stampDeferredDisposition and
    // interpolate unchecked into `pulls/comments/null` — a bare "gh command
    // failed: <404 text>" names neither the thread nor the cause.
    if (!Number.isInteger(thread.commentId) || thread.commentId <= 0) {
      throw new Error(`Thread ${thread.threadId} carries a gate-authored finding marker selected for deferral but has no resolvable comment id (commentId=${JSON.stringify(thread.commentId)}); refuse to stamp/resolve it.`);
    }
    targets.push({ threadId: thread.threadId, commentId: thread.commentId, severity: marker.severity });
  }
  return targets;
}

// Stamp `disposition=deferred` onto the thread's line-1 marker before the
// resolve, so a deferred thread is distinguishable from a worth-fixing-now
// thread the fix loop resolved with a fixing commit: the deferred summary
// filters on this field and would otherwise list fixed findings as deferred.
// The already-stamped guard parses the marker's own `disposition` field (not a
// free-text `/disposition=deferred/` body search): a finding whose own summary
// or recommendation happens to quote that literal token must never be
// mistaken for an already-stamped marker.
async function stampDeferredDisposition({ repo, commentId }, { env, ghCommand }) {
  const current = await runChildPlain(
    ghCommand,
    ["api", `repos/${repo}/pulls/comments/${commentId}`],
    env,
  );
  assertGhSuccess(current);
  const payload = parseJsonText(current.stdout, { label: "gh api pulls comments (GET)" });
  // Trimmed to match parseReviewThreads' normalizeBody, which is what
  // selectDispositionTargets parsed thread.body through to select this exact
  // comment as a deferral target: two differently normalized copies of one
  // body could disagree on whether `^` (FINDING_MARKER_RE is line-start
  // anchored) matches a marker preceded by leading whitespace.
  const body = typeof payload?.body === "string" ? payload.body.trim() : "";
  const marker = parseFindingMarker(body);
  if (!marker) {
    throw new Error(`Review comment ${commentId} was selected as a deferral target but no longer carries a parseable finding marker; refuse to resolve it unstamped.`);
  }
  if (marker.disposition === "deferred") return;
  const stamped = body.replace(FINDING_MARKER_RE, (m) => m.replace(/\s*-->$/, " disposition=deferred -->"));
  const patched = await runChildPlain(
    ghCommand,
    ["api", "-X", "PATCH", `repos/${repo}/pulls/comments/${commentId}`, "-f", `body=${stamped}`],
    env,
  );
  assertGhSuccess(patched);
}

// `snapshot` is the full-body review-thread snapshot the caller already
// fetched alongside `threads` (fetchThreadsWithFullBodies) — reused here as
// the reply-target validation snapshot rather than re-fetching it, since it is
// already fresh (fetched immediately before this pass runs).
async function runDispositionPass({ repo, pr, round, threads, snapshot, login }, { env, ghCommand }) {
  const targets = selectDispositionTargets(threads, round, login);
  if (targets.length === 0) {
    return { resolvedThreadIds: new Set(), deferredResolved: 0 };
  }
  const message = dispositionMessage(round);
  const resolvedThreadIds = new Set();
  for (const target of targets) {
    await stampDeferredDisposition({ repo, commentId: target.commentId }, { env, ghCommand });
    await replyAndMaybeResolve(
      { repo, pr, commentId: target.commentId, threadId: target.threadId, body: message, resolve: true, validatedSnapshot: snapshot },
      { env, ghCommand },
    );
    resolvedThreadIds.add(target.threadId);
  }
  return { resolvedThreadIds, deferredResolved: resolvedThreadIds.size };
}

// ---------------------------------------------------------------------------
// Deferred-summary rebuild (rebuilt entirely from markers, no local state)
// ---------------------------------------------------------------------------

function extractFindingLineFromBody(body) {
  const lines = typeof body === "string" ? body.split(/\r?\n/) : [];
  return lines.length > 1 ? lines[1] : null;
}

// `threads` must carry FULL first-comment bodies (see fetchThreadsWithFullBodies):
// the marker line alone can run past list-review-threads.mjs's 200-char listing
// excerpt once an angle/disposition suffix is stamped, and truncating the
// summary line the same way would silently corrupt the Summary column.
function buildThreadSummaryRows(threads, resolvedThreadIds, { repo, pr }) {
  const rows = [];
  for (const thread of threads) {
    const isResolved = thread.isResolved || resolvedThreadIds.has(thread.threadId);
    if (!isResolved) continue;
    const marker = parseFindingMarker(thread.body);
    if (!marker || !SUMMARY_SEVERITY_ORDER.includes(marker.severity)) continue;
    // Deferred threads only: a thread deferred THIS run is known locally; one
    // deferred in an earlier run carries the stamped marker field. A resolved
    // worth-fixing-now thread with neither was FIXED by the fix loop and must
    // not be listed as deferred.
    const wasDeferred = resolvedThreadIds.has(thread.threadId) || marker.disposition === "deferred";
    if (!wasDeferred) continue;
    const parsedLine = parseFindingLine(extractFindingLineFromBody(thread.body));
    rows.push({
      severity: marker.severity,
      angle: marker.angle,
      round: marker.round,
      summary: parsedLine?.summary ?? "(see thread)",
      location: thread.path ? `${thread.path}${Number.isInteger(thread.line) ? `:${thread.line}` : ""}` : "—",
      fingerprint: marker.fp,
      threadLabel: thread.commentId ? `#discussion_r${thread.commentId}` : null,
      threadUrl: thread.commentId ? `https://github.com/${repo}/pull/${pr}#discussion_r${thread.commentId}` : null,
    });
  }
  return rows;
}

// Every finding filed in a review body (non-locatable — no code location, so
// it can never become a resolvable thread) is, by construction, permanently
// deferred: it stays suppressed by fingerprint but nothing ever resolves it.
function splitFindingBlocks(bodyText) {
  const lines = typeof bodyText === "string" ? bodyText.split(/\r?\n/) : [];
  const blocks = [];
  let current = null;
  for (const rawLine of lines) {
    // Marker recognition is column-0 only (FINDING_MARKER_RE is line-start
    // anchored), matching exactly what selectDispositionTargets/
    // collectFingerprints/parseFindingMarker(thread.body) accept elsewhere in
    // this module — a leading-whitespace-padded line here would otherwise
    // feed a summary row while contributing nothing to suppression or thread
    // disposition, two acceptance rules for the same marker text.
    const marker = rawLine.startsWith("<!--") ? parseFindingMarker(rawLine) : null;
    const trimmed = rawLine.trim();
    if (marker) {
      current = { marker, lines: [] };
      blocks.push(current);
      continue;
    }
    if (current && trimmed.length > 0) {
      current.lines.push(trimmed);
    }
  }
  return blocks;
}

function buildBodyFiledSummaryRows(reviews, { repo, pr }) {
  const rows = [];
  for (const review of reviews) {
    for (const block of splitFindingBlocks(review.body)) {
      if (!SUMMARY_SEVERITY_ORDER.includes(block.marker.severity)) continue;
      // Mirrors buildThreadSummaryRows' deferred-only filter, but a body-filed
      // finding is stamped disposition=deferred unconditionally at render time
      // (see renderNonLocatableBlock) — every non-must-fix body-filed finding
      // is deferred by construction, round-independent, since it never gets a
      // thread to fix it through. This check is therefore now a defensive
      // no-op for anything this module renders; it still protects against a
      // hand-authored or historical marker that lacks the field.
      if (block.marker.disposition !== "deferred") continue;
      const parsedLine = parseFindingLine(block.lines[0] ?? "");
      rows.push({
        severity: block.marker.severity,
        angle: block.marker.angle,
        round: block.marker.round,
        summary: parsedLine?.summary ?? "(see PR review body)",
        location: "—",
        fingerprint: block.marker.fp,
        threadLabel: Number.isInteger(review.id) ? `#pullrequestreview-${review.id}` : null,
        threadUrl: Number.isInteger(review.id) ? `https://github.com/${repo}/pull/${pr}#pullrequestreview-${review.id}` : null,
      });
    }
  }
  return rows;
}

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

// list-review-threads.mjs's fetchAllReviewThreads deliberately excerpts each
// thread's first-comment body to a bounded length for cheap listing. Every
// decision this module makes off a thread body (marker parsing, disposition,
// suppression, the deferred-summary text) needs the UNTRUNCATED body, so join
// the listing (threadId/commentId/path/line/isResolved) with
// captureParsedReviewThreads' full first-comment text, keyed on the comment
// databaseId the two share. The two are INDEPENDENT paginated GraphQL walks,
// though: a thread created or cursor-shifted between them can be present in
// one and absent from the other, so a join miss must fail closed rather than
// silently fall back to the truncated excerpt (which could run every
// downstream decision on a body cut mid-marker, varying with fetch
// interleaving alone). The excerpt is self-identifying — excerptBody only ever
// appends a trailing U+2026 when the body's length actually exceeded
// list-review-threads.mjs's BODY_EXCERPT_MAX_CHARS — so only fail when the
// join misses AND the listing body is BOTH over that length AND ends with the
// ellipsis; a short body that legitimately ends with its own literal "…"
// character (a reviewer's own prose) never needed truncation and is already
// complete, so it is safe to keep as-is.
const BODY_EXCERPT_ELLIPSIS = "…";

function isTruncatedListingExcerpt(body) {
  return typeof body === "string" && body.length > BODY_EXCERPT_MAX_CHARS && body.endsWith(BODY_EXCERPT_ELLIPSIS);
}

async function fetchThreadsWithFullBodies({ repo, pr }, gh) {
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

// No summary comment is ever CREATED for a zero-deferral trigger: there is
// nothing yet to tell an operator about, and posting an empty-table comment
// on every clean close would be noise, not signal. An EXISTING summary
// comment is still updated in place even when rows is now empty (a
// previously-deferred finding could only empty out by disappearing from
// every marker source this module rebuilds from, which never happens today,
// but the in-place update path stays unconditional on `existing` regardless).
async function upsertDeferredSummary({ repo, pr, rows }, { env, ghCommand }) {
  const comments = await listIssueComments({ repo, pr }, { env, ghCommand });
  const existing = findMarkedComment(comments, DEFERRED_SUMMARY_MARKER);
  if (!existing && rows.length === 0) {
    return "no_deferred_findings";
  }
  const body = renderDeferredSummaryBody({ pr, rows });
  if (existing) {
    await updateComment({ repo, commentId: existing.id, body }, { env, ghCommand });
    return "updated";
  }
  await commentIssue({ repo, issue: pr, body }, { env, ghCommand });
  return "created";
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

export function parseCloseGateFindingsCliArgs(argv) {
  const options = { help: false, ledgerPath: undefined, tmpRoot: "tmp" };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      ledger: { type: "string" },
      "tmp-root": { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "ledger") {
      const p = requireTokenValue(token, parseError).trim();
      if (p.length === 0) {
        throw parseError("--ledger requires a non-empty path");
      }
      options.ledgerPath = p;
      continue;
    }
    if (token.name === "tmp-root") {
      const t = requireTokenValue(token, parseError).trim();
      if (t.length === 0) {
        throw parseError("--tmp-root requires a non-empty path");
      }
      options.tmpRoot = t;
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.ledgerPath === undefined) {
    throw parseError("Missing required argument: --ledger <path>");
  }
  return options;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function closeGateFindings(options, { env = process.env, ghCommand = "gh", repoRoot = process.cwd() } = {}) {
  const { repo, pr, gate, headSha, verdict, findings } = await readLedger(options.ledgerPath);
  const tmpRoot = options.tmpRoot || "tmp";
  const gh = { env, ghCommand };

  // 0. The authenticated login — the trust boundary for every provenance
  // decision below (which review/thread is gate-authored), resolved once and
  // reused rather than trusted from rendered marker text.
  const login = await resolveAuthenticatedLogin(gh);

  // 1. Review bodies (suppression + gate-scoped round cross-check).
  const reviews = await listPrReviews({ repo, pr }, gh);
  // 2. All review threads, resolved included (suppression), full bodies joined.
  const { threads: threadsPrePost } = await fetchThreadsWithFullBodies({ repo, pr }, gh);
  const suppressed = new Set();
  // Only OUR OWN review/thread bodies fold their finding markers into the
  // suppression set: a foreign review or thread quoting (or forging) a marker
  // that happens to fingerprint-match a real finding must never silently
  // suppress it from being re-raised.
  for (const review of reviews) {
    if (review.author === login) collectFingerprints(review.body, suppressed);
  }
  for (const thread of threadsPrePost) {
    if (thread.author === login) collectFingerprints(thread.body, suppressed);
  }

  // 3. Round.
  const verdictComments = await listIssueComments({ repo, pr }, gh);
  // `reviews` is already fetched above (step 1); this module's own
  // gate-findings review body never opens with the "### Gate review:" header,
  // so there is no self-count risk scanning it here too.
  const verdictHeadShas = new Set();
  collectVerdictHeadShas(verdictComments, gate, verdictHeadShas);
  collectVerdictHeadShas(reviews, gate, verdictHeadShas);
  const primaryRound = verdictHeadShas.size;
  const crossCheckRound = crossCheckRoundFromReviewBodies(reviews.map((r) => r.body), gate);
  const fallbackRound = await countLocalFindingsLogFiles({ repo, pr, gate, headSha, tmpRoot, repoRoot });
  const round = Math.max(primaryRound, crossCheckRound, fallbackRound, 1);

  // 4. Dedupe against the suppression set.
  const candidates = findings.filter((f) => !suppressed.has(fingerprintFinding(f)));
  const suppressedCount = findings.length - candidates.length;

  // 5. Partition locatable vs non-locatable.
  let locatable = [];
  let nonLocatable = [];
  if (candidates.length > 0) {
    const files = await fetchPrFiles({ repo, pr }, gh);
    const commentableSet = buildCommentableLineSet(files);
    for (const finding of candidates) {
      (isLocatableFinding(finding, commentableSet) ? locatable : nonLocatable).push(finding);
    }
  }

  // 6. Post the review (skipped entirely when there is nothing new to say).
  if (locatable.length > 0 || nonLocatable.length > 0) {
    const reviewBody = renderReviewBody({ gate, headSha, round, nonLocatable });
    const comments = locatable.map((finding) => ({
      path: finding.files[0],
      line: finding.line,
      side: "RIGHT",
      body: renderInlineCommentBody(finding, { round }),
    }));
    const response = await postReview({ repo, pr, headSha, body: reviewBody, comments }, gh);
    reviews.push({ id: Number.isInteger(response?.id) ? response.id : null, body: reviewBody });
  }

  // 7. Fresh thread snapshot for the disposition pass (always re-fetched: a
  // body-only post changes nothing thread-side, but a carried-open thread from
  // an earlier round must be reconciled against THIS round regardless).
  const { threads: threadsForDisposition, snapshot: dispositionSnapshot } = await fetchThreadsWithFullBodies({ repo, pr }, gh);
  const { resolvedThreadIds, deferredResolved } = await runDispositionPass(
    { repo, pr, round, threads: threadsForDisposition, snapshot: dispositionSnapshot, login },
    gh,
  );

  // 8. Deferred-summary trigger — evaluated unconditionally, including a
  // zero-findings round (that is exactly the round most likely to trigger it).
  const unresolvedGateThreadCount = threadsForDisposition.filter((thread) => {
    if (thread.isResolved || resolvedThreadIds.has(thread.threadId)) return false;
    return parseFindingMarker(thread.body) !== null;
  }).length;
  const triggered = gate === "pre_approval_gate" && verdict === "clean" && unresolvedGateThreadCount === 0;
  let summaryAction = "not_triggered";
  if (triggered) {
    const rows = [
      ...buildThreadSummaryRows(threadsForDisposition, resolvedThreadIds, { repo, pr }),
      ...buildBodyFiledSummaryRows(reviews, { repo, pr }),
    ];
    summaryAction = await upsertDeferredSummary({ repo, pr, rows }, gh);
  }

  return {
    ok: true,
    repo,
    pr,
    gate,
    headSha,
    round,
    posted: locatable.length,
    bodyFiled: nonLocatable.length,
    suppressed: suppressedCount,
    deferredResolved,
    summary: summaryAction,
  };
}

async function main() {
  let options;
  try {
    options = parseCloseGateFindingsCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  try {
    const result = await closeGateFindings(options);
    process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  await main();
}
