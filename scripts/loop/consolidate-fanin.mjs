#!/usr/bin/env node
/**
 * consolidate-fanin.mjs — sanctioned fan-in CLI over the pure helpers in
 * @dev-loops/core/loop/gate-fanin (issue #1481). Reads every per-angle
 * findings artifact a gate-review fan-out produced, consolidates them with
 * consolidateFanin()/toFindingsLogShape(), and emits the JSON shapes
 * write-gate-findings-log.mjs (--findings / --findings-file), post-gate-findings.mjs
 * (--findings / --findings-file), and upsert-checkpoint-verdict.mjs (--findings-json,
 * via the result's "findingsJson" field / --out) accept directly — the orchestrator
 * no longer hand-authors this JSON with inline interpreters. "findingsJson"/--out is
 * the NESTED per-angle shape (one section per source artifact, clean angles included
 * with an empty findings array); "findings"/--ledger-out is the FLAT per-finding shape.
 *
 * Per-angle findings artifact shape (one *.json file per angle in --findings-dir):
 *   {
 *     angle: string,
 *     verdict: "clean" | "findings_present" | "blocked",
 *     headSha: string,   // required whenever --head-sha is given (exempt: blocked / declared-carried)
 *     findings: [{ severity, summary, file?, line?, disposition?, recommendation? }]
 *   }
 * `disposition` on an input finding is IGNORED — consolidateFanin() always
 * DERIVES it from severity (accepted-for-fix for a blocking severity,
 * deferred otherwise). It is accepted on the input shape only so a reviewer's
 * own artifact schema round-trips without a separate strip step. A
 * reviewer-provided `recommendation` IS carried through to both output shapes
 * unchanged (truncated only if it exceeds the length cap below).
 *
 * An angle reporting verdict "blocked" (or any malformed artifact) makes the
 * whole fan-in FAIL CLOSED (exit 1, naming the offending angles): a blocked
 * consolidation has no publishable findings shape, and emitting one would
 * present an all-clean structure that silently discards real findings. Fix or
 * re-run the offending reviewer, then re-consolidate. Two artifacts naming the
 * SAME angle also fails closed (ambiguous fan-out) — see "duplicate angle
 * name" below.
 *
 * The render budget applies ONLY to "findingsJson"/--out (the visible gate
 * comment) — never to "findings"/--ledger-out (the durable disposition
 * ledger, which write-gate-findings-log.mjs accepts at arbitrary size). Fit is
 * measured by actually RENDERING a candidate shape through
 * upsert-checkpoint-verdict.mjs's own normalizeStructuredFindings/
 * renderStructuredFindings and catching the length-exceeded throw — never an
 * approximated size. A round too large to render even at minimum summary
 * length degrades "findingsJson"/--out through four tiers (real -> verbose
 * marker -> bare marker -> withheld) when --ledger-out was given, or FAILS
 * CLOSED (exit 1) otherwise — the normative tier-by-tier algorithm is owned by
 * the Gate Review Sub-Loop Contract's Phase 3 "Consolidation: fan-in synthesis
 * and disposition ledger" section (skills/docs/gate-review-sub-loop-contract.md),
 * not restated here; see the --out flag below for the CLI-facing summary.
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { GATE_NAMES } from "../github/_gate-names.mjs";
import { isPostedCommentLimitError, normalizeStructuredFindings, renderStructuredFindings } from "../github/upsert-checkpoint-verdict.mjs";
import { loadDevLoopConfig, resolveGateAngleContract, resolveGateConfig } from "@dev-loops/core/config";
import { angleReviewSurface } from "@dev-loops/core/loop/gate-carry-forward";
import { FANIN_SYNTHETIC_ANGLES, SEVERITY_ORDER, VALID_SEVERITIES, baseAngleName, consolidateFanin, toFindingsLogShape } from "@dev-loops/core/loop/gate-fanin";

const USAGE = `Usage: consolidate-fanin.mjs --findings-dir <dir> [--head-sha <sha>] [--gate <draft_gate|pre_approval_gate>] [--out <path>] [--ledger-out <path>] [--pr-checklist-matrix clean] [--carried-angles <json> --carry-forward-plan <json>] [--repo-root <path>]
Consolidate the per-angle *.json findings artifacts a gate-review fan-out wrote into
--findings-dir into the JSON shapes write-gate-findings-log.mjs, post-gate-findings.mjs
(--findings / --findings-file), and upsert-checkpoint-verdict.mjs (--findings-json) accept.
Required:
  --findings-dir <dir>          Directory containing one *.json per-angle findings
                                 artifact: { angle, verdict, headSha, findings: [{ severity, summary, file?, line?, disposition?, recommendation? }] }
                                 (headSha required whenever --head-sha is given; exempt for blocked or declared-carried angles).
                                 An input finding's "disposition" (if present) is IGNORED — the
                                 output disposition is always DERIVED from severity (see below).
                                 An input finding's "recommendation" (if present) is carried through.
                                 Two artifacts naming the SAME angle fail closed (ambiguous fan-out).
Optional:
  --head-sha <sha>              The round's reviewed head (7-64 char hex SHA). When given,
                                 every artifact read from --findings-dir must carry a
                                 "headSha" stamp equal to it (trim+lowercase compare) —
                                 a mismatched stamp OR a missing/malformed stamp FAILS
                                 CLOSED naming the angle, unless that angle is declared in
                                 --carried-angles (an explicit, plan-proven carry-forward
                                 keeps the existing behavior; provenance stays the ledger's
                                 carriedFromHead, never a second field). Omit for the
                                 pre-stamp behavior (no head check). This is what makes a
                                 stale artifact staged from an earlier round distinguishable
                                 from a fresh verdict at the reviewed head.
  --gate <draft_gate|pre_approval_gate>   Echoed onto the result as "gate"; also loads this
                                 worktree's config and applies gates.<gate>.blockCleanOnFindingSeverities
                                 to the overall verdict (default when omitted: ["must-fix"]). When given,
                                 a config that could not be fully loaded/validated FAILS CLOSED (exit 1)
                                 rather than silently falling back to the shipped default severities.
  --out <path>                  Write the nested per-angle "findingsJson" shape (below) to this
                                 path as JSON — the exact input upsert-checkpoint-verdict.mjs's
                                 --findings-json accepts. Once the whole round is still over the
                                 gate-comment render budget AT MINIMUM SUMMARY LENGTH (a round that
                                 fits once its summaries are shrunk never degrades), this file
                                 degrades through the four tiers documented in the Gate Review
                                 Sub-Loop Contract's Phase 3 (skills/docs/gate-review-sub-loop-contract.md)
                                 — REMOVED (deleted, not skipped) in the rare tier-4/withheld case.
                                 --ledger-out is unaffected either way. A round still over the render
                                 budget at minimum summary length FAILS CLOSED (exit 1) when
                                 --ledger-out was not also given — a degraded round otherwise has no
                                 durable record of its findings anywhere.
  --ledger-out <path>            Write the flat "findings" shape (below) to this path as JSON — the
                                 exact --findings-file input write-gate-findings-log.mjs and
                                 post-gate-findings.mjs accept. Rejected at parse time (exit 1) when
                                 it resolves to the same path as --out — one write would otherwise
                                 destroy the other. Neither --out nor --ledger-out may resolve to a
                                 DIRECT TOP-LEVEL sibling of --findings-dir's own artifacts (also
                                 rejected at parse time, exit 1) — the withheld tier deletes --out
                                 outright (so an --out aliased to a reviewer artifact would delete it),
                                 and a .json write there would be picked up as a per-angle findings
                                 artifact by the NEXT consolidation of that same directory. A path in a
                                 SUBdirectory of --findings-dir (e.g. <findings-dir>/out/findings.json)
                                 is unaffected — artifact discovery is top-level-only, so it can never
                                 be re-read as an artifact.
  --pr-checklist-matrix clean    When no pr-checklist-matrix angle artifact was found, upsert
                                 { angle: "pr-checklist-matrix", verdict: "clean", findings: [] }
  --carried-angles <json>        JSON array of angle-name strings CARRIED FORWARD from a prior clean
                                 head (the "angle" field of each entry in resolve-angle-carry-forward.mjs's
                                 plan.carried) rather than freshly reviewed this round — Phase 2 dispatches
                                 no artifact for them, so without this flag they are invisible to
                                 findingsJson/checkFanoutAngleCoverage and the posted verdict comment reads
                                 as a truncated fan-out instead of a full one. REQUIRES --gate and
                                 --carry-forward-plan (below) — this CLI never mints a carried entry from a
                                 bare name alone. For any named angle with no real per-angle artifact,
                                 upserts { angle, verdict: "clean", findings: [], carriedFromHead } (a real
                                 artifact for that angle, if present — matched by base name and
                                 case-insensitively, same rule resolve-angle-carry-forward.mjs uses — always
                                 wins; this never overrides one). Same upsert semantics as
                                 --pr-checklist-matrix, generalized, plus the two guards below. FAILS CLOSED
                                 (exit 1) on any named angle whose angleReviewSurface(...).kind !== "kinds"
                                 (@dev-loops/core/loop/gate-carry-forward) — the SAME predicate
                                 resolve-angle-carry-forward.mjs's own producer uses for plan.carried
                                 membership, fed --gate's configured mandatoryAngles as alwaysRerun: this
                                 refuses a configured MANDATORY angle, a hardcoded ALWAYS_INCLUDE angle
                                 (gate-evidence/renderer-security/pr-description, unconditionally, regardless
                                 of config), and an unmapped/unknown angle in one seam — or is absent from
                                 --carry-forward-plan's own "carried" list — refusing to manufacture
                                 GitHub-visible "reviewed at this head" evidence for an angle nothing
                                 actually proved was carried.
  --carry-forward-plan <json>    resolve-angle-carry-forward.mjs's own JSON result, any object with its
                                 "carried" field, or a bare JSON array of carried entries:
                                 [{ angle, carriedFromHead, reason?, reviewer?, dispatchId?, model? }] — the
                                 proof --carried-angles is checked against. Each entry's carriedFromHead must
                                 be a 7-64 char hex SHA (write-gate-findings-log.mjs's own provenance bound;
                                 normalized trim+lowercase). Required together with --carried-angles (given
                                 without it, or vice versa, fails closed at parse time).
  --repo-root <path>             Root used to resolve this worktree's config (loadDevLoopConfig) when
                                 --gate is given (default: process.cwd()) — makes the overall verdict
                                 deterministic regardless of the CLI's invocation directory
Output (stdout, JSON):
  { "ok": true, "gate"?: "...", "angles": [{ "angle", "verdict", "findingCount", "carriedFromHead"? }],
    "findingsJson": [{ "angle", "verdict", "findings": [...], "carriedFromHead"? }], "findings": [...],
    "severityCounts": { "must-fix", "worth-fixing-now", "defer" },
    "overallVerdict": "clean"|"findings_present", "commentBudgetExceeded"?: true }
  A "carriedFromHead" field appears ONLY on an entry --carried-angles upserted (the prior head SHA it
  was carried from, taken from --carry-forward-plan) — every freshly reviewed angle's entry omits it,
  so a consumer can distinguish a carried verdict from a fresh review without reading the ledger's
  provenance. upsert-checkpoint-verdict.mjs's renderer ignores unrecognized per-angle fields, so this
  never affects the rendered gate comment.
  "findingsJson" is the nested per-angle shape (one section per source artifact, including clean
  angles with an empty findings array) — pass --out's file straight to
  upsert-checkpoint-verdict.mjs's --findings-json. "findings" is the FLAT per-finding shape — pass
  --ledger-out's file straight to write-gate-findings-log.mjs/post-gate-findings.mjs's
  --findings-file, and is ALWAYS complete (never budgeted). "severityCounts" is likewise ALWAYS the
  true, unbudgeted totals across every finding, independent of any marking applied to "findingsJson"
  below. Every output finding's "disposition" is DERIVED from severity (accepted-for-fix for a
  blocking severity, deferred otherwise) — an input finding's own "disposition" is never honored,
  including on a budget-marker finding (below). A reviewer-provided "recommendation" is carried
  through to both shapes unchanged. A finding "summary" or "recommendation" longer than 2000 chars,
  or "file" longer than 300 chars, is truncated with a plain " …" suffix (never a "[truncated N
  chars]" marker), and "findingsJson"
  (--out) alone is bounded against upsert-checkpoint-verdict.mjs's OWN rendered-block limit — fit is
  measured by actually rendering a candidate through that CLI's normalizeStructuredFindings/
  renderStructuredFindings and catching the throw, not an approximated size. A round over that
  bound degrades through the four tiers (real -> verbose marker -> bare marker -> withheld)
  documented in the Gate Review Sub-Loop Contract's Phase 3
  (skills/docs/gate-review-sub-loop-contract.md); "commentBudgetExceeded": true marks every
  degraded round (tiers 1-4 alike; --out's existence is what distinguishes tier 4). "findings"/
  --ledger-out is always unaffected. NOTE: upsert-checkpoint-verdict.mjs's posted "Findings
  summary:" digest is derived from "findingsJson" (undercounting marker-collapsed findings) UNLESS
  the caller also passes --findings-severity-counts with this CLI's own "severityCounts" (always
  the true, unbudgeted totals) — "findings"/--ledger-out and the marker text's own breakdown
  always carry the true numbers regardless.
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error, a malformed --head-sha (not a 7-64 char hex SHA string), a
     mismatched/missing/malformed artifact "headSha" stamp for a non-blocked,
     non-carried angle when --head-sha is given,
     missing/empty --findings-dir, unparseable artifact, a per-angle
     artifact that self-declares "carriedFromHead", schema violation, duplicate angle
     name across artifacts, blocked fan-in (a malformed or blocked per-angle artifact),
     (with --gate) an unloadable/invalid worktree config, a --carried-angles entry whose
     angleReviewSurface(...).kind !== "kinds" (a configured mandatory angle, a hardcoded
     ALWAYS_INCLUDE angle, or an unmapped/unknown angle) or is absent from
     --carry-forward-plan's "carried" list, --carried-angles given without
     --carry-forward-plan/--gate (or vice versa), a --carry-forward-plan entry with a
     malformed "carriedFromHead" (not a 7-64 char hex SHA), or a round still over the
     render budget at minimum summary length with --ledger-out not given
  2  Invalid --jq filter`.trim();

const parseError = buildParseError(USAGE);

const VALID_GATES = new Set(GATE_NAMES);
// Findings text (summary/recommendation) longer than this is truncated with a
// plain " …" suffix before emission — matching upsert-checkpoint-verdict.mjs's
// plain-ellipsis truncation policy (never the "[truncated N chars]" marker,
// which that CLI reserves for a posted comment being SHORTENED, not this
// tool's own findings text). upsert-checkpoint-verdict.mjs also bounds the
// WHOLE rendered --findings-json block and FAILS CLOSED above it, so a
// per-field cap alone is not enough — see fitsRenderBudget below, which
// measures that bound directly rather than duplicating its number here.
const MAX_FINDING_TEXT_LENGTH = 2000;
// A finding's "file" is a path reference, not prose — no legitimate path
// approaches even a fraction of MAX_FINDING_TEXT_LENGTH. Unlike summary/
// recommendation, "file" was previously copied through unbounded (gate-fanin's
// consolidateFanin only .trim()s it), so an oversized value could not be
// compressed by fitFindingsToRenderBudget (which only shrinks summary) and
// would force a real, short finding into the marker/withheld tiers instead.
const MAX_FINDING_FILE_LENGTH = 300;
function truncateFindingText(value, limit = MAX_FINDING_TEXT_LENGTH) {
  if (typeof value !== "string" || value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 2))} …`;
}

// Does a candidate findingsJson shape actually fit upsert-checkpoint-verdict.mjs's
// posted-comment render bound? Measured by RENDERING it through that CLI's own
// normalizeStructuredFindings/renderStructuredFindings and catching the
// length-exceeded throw — not an approximated size. An estimate has to
// reproduce every rendering detail (per-line decoration, sanitizeStructuredInline's
// escaping) to stay accurate, and drifts the moment it does not; rendering the
// real candidate can't drift because it IS the bound.
// Only renderStructuredFindings' own length-exceeded throw
// (enforcePostedCommentLimit, tagged with the stable
// isPostedCommentLimitError code) means "does not fit" — normalizeStructuredFindings can
// also throw on shape drift (unrecognized items, mixed nested+flat) and
// renderStructuredFindings(null) throws a TypeError on an empty angle list; neither is a
// budget question, and misreading either as "over budget" would silently degrade a
// producer/shape defect to a withheld or marker-collapsed round instead of failing
// closed. Rethrow anything that isn't the length-bound error.
// Exported so tests can drive the length-vs-shape discrimination directly
// against the real normalizeStructuredFindings/renderStructuredFindings pair,
// without needing a --findings-dir fixture that (today) cannot reach a
// shape-invalid candidate through the public consolidateGateFanin API.
export function fitsRenderBudget(findingsJson) {
  try {
    renderStructuredFindings(normalizeStructuredFindings(findingsJson));
    return true;
  } catch (err) {
    if (isPostedCommentLimitError(err)) return false;
    throw err;
  }
}

// Shrink the longest summaries evenly until the candidate actually renders —
// deterministic. Returns whether the (mutated in place) findingsJson now fits;
// the caller decides what to do when the floor is reached and it still does
// not (see buildAngleMarker below). A round too large to render never blocks
// the durable ledger write, but that guarantee comes from the ledger being
// written BEFORE this function runs (see the write ordering below), not from
// this function itself: it still propagates any non-length-bound error that
// fitsRenderBudget rethrows (a real shape/producer defect).
function fitFindingsToRenderBudget(findingsJson) {
  let cap = MAX_FINDING_TEXT_LENGTH;
  while (!fitsRenderBudget(findingsJson) && cap > 40) {
    cap = Math.floor(cap / 2);
    for (const a of findingsJson) {
      for (const f of a.findings) {
        f.summary = truncateFindingText(f.summary, cap);
      }
    }
  }
  return fitsRenderBudget(findingsJson);
}

// Floor reached and still over budget: the fan-in has too many findings to
// render in one gate comment no matter how short each summary gets. Collapse
// ONE angle's findings to a single synthetic marker finding rather than
// failing closed — the durable ledger (--ledger-out) already carries every
// finding in full; only the rendered comment is space-constrained. The angle
// name and its real verdict are PRESERVED (never collapsed into a foreign
// section) — upsert-checkpoint-verdict.mjs's fanout_fanin mode validates the
// posted angle set against the gate's configured mandatory angles/pool, so a
// synthetic angle name or a missing real one would make the verdict itself
// unpostable, which is the exact failure this exists to avoid. `verbose`
// states the omitted count and severity breakdown; the caller (below) picks
// `false` for a bare "N omitted — in ledger" line, decided PER ANGLE so a
// round with a mix of wide and narrow angles keeps the breakdown wherever it
// actually fits rather than dropping it everywhere the instant any single
// angle can't afford it. Never partially truncates the marker text itself —
// always the whole verbose sentence or the whole bare one, so a marker is
// always lossless or bare, never a mangled hybrid.
function buildAngleMarker(a, verbose) {
  if (a.findings.length === 0) return a; // clean angle: nothing omitted
  const bySeverity = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0]));
  for (const f of a.findings) {
    if (Object.hasOwn(bySeverity, f.severity)) bySeverity[f.severity] += 1;
  }
  // Represent the angle by its own highest-severity dropped finding — same
  // severity+disposition pairing consolidateFanin already derived, so the
  // marker's "disposition" still matches every other findingsJson finding's
  // severity-derived disposition (accepted-for-fix for a blocking severity,
  // deferred otherwise).
  const representative = SEVERITY_ORDER
    .map((s) => a.findings.find((f) => f.severity === s))
    .find(Boolean) ?? a.findings[0];
  // Built from SEVERITY_ORDER (not hand-listed severity names) so a severity
  // added there is automatically included in the breakdown instead of being
  // silently omitted from the only in-comment record a marker-collapsed round
  // carries.
  const severityBreakdown = SEVERITY_ORDER.map((s) => `${s}: ${bySeverity[s]}`).join(", ");
  const summary = verbose
    ? `${a.findings.length} finding(s) omitted from this comment (${severityBreakdown}) — in the disposition ledger`
    : `${a.findings.length} omitted — in ledger`;
  return {
    angle: a.angle,
    verdict: a.verdict,
    findings: [{ severity: representative.severity, summary, disposition: representative.disposition }],
  };
}

// Build the over-budget --out shape once fitFindingsToRenderBudget has given
// up on the WHOLE round's real findings: seed every angle with findings at
// whichever costs less in isolation, its bare marker or its own real findings
// (see the seed loop below), so an early, single render check tells us
// whether ANY per-angle shape can fit at all (tier 4 below). If that seed
// fits, greedily upgrade the angles still seeded bare, one at a time in
// blocking-severity order, trying that angle's REAL findings (the pre-shrink
// original first, then the whole-round-shrunk form) before its verbose
// marker — a marker is a compression and must never replace real content
// with something bigger. An angle already seeded with its real findings is
// never revisited: it already holds its ideal (real, unmarked) shape. Every
// upgrade is kept only while the WHOLE round still renders. Returns
// { commentFindingsJson, withheldOut }.
// The angle's own worst (most blocking) severity among its real findings, as
// a SEVERITY_ORDER index (0 = must-fix, lower is more severe); a clean angle
// (no findings) ranks last. Used only to ORDER the greedy upgrade below by
// decision value, never to change which findings a marker represents.
function angleWorstSeverityRank(a) {
  let best = SEVERITY_ORDER.length;
  for (const f of a.findings) {
    const idx = SEVERITY_ORDER.indexOf(f.severity);
    if (idx !== -1 && idx < best) best = idx;
  }
  return best;
}

// Render-cost proxy for one angle's candidate shape, in isolation — used only
// to pick the cheaper of two shapes for the SAME angle (bare marker vs its
// own real findings), never to judge whole-round fit (that stays an actual
// renderStructuredFindings call over the whole array). A candidate so large
// that even alone it exceeds the comment-length bound sorts last (Infinity),
// since it can never be the cheaper choice.
function angleRenderCost(a) {
  try {
    return renderStructuredFindings(normalizeStructuredFindings([a])).length;
  } catch (err) {
    // Same length-vs-shape discrimination as fitsRenderBudget above: only a
    // length-bound throw means "too expensive", never a shape/producer defect.
    if (isPostedCommentLimitError(err)) return Infinity;
    throw err;
  }
}

function buildBudgetMarkedFindingsJson(findingsJson, originalFindingsJson) {
  const bareMarkers = findingsJson.map((a) => buildAngleMarker(a, false));
  // The bare marker is USUALLY the cheapest possible per-angle shape, but not
  // always: a narrow angle carrying very few, very short real findings can
  // render shorter than even the compressed "N omitted — in ledger" line.
  // Seed each angle with whichever of the two costs less in isolation, so the
  // tier-4 feasibility probe below tests the actual cheapest achievable shape
  // instead of assuming bare-everywhere always is the smallest. An angle
  // seeded with its own real findings here already holds its ideal (real,
  // unmarked) form and is never later replaced with a marker — a marker is a
  // compression and must never replace real content with something bigger.
  const marked = findingsJson.map((a, i) => {
    if (a.findings.length === 0) return a; // clean angle: nothing to compress
    return angleRenderCost(a) <= angleRenderCost(bareMarkers[i]) ? a : bareMarkers[i];
  });
  if (!fitsRenderBudget(marked)) {
    // Structural floor: this many real angles (far beyond the default
    // fan-out cap) means even the cheapest per-angle shape available cannot
    // fit — no per-angle shape can, no matter how short the text gets.
    return { commentFindingsJson: [], withheldOut: true };
  }
  // Upgrade angles to the verbose breakdown in order of blocking severity
  // (must-fix carriers first), not artifact-index/filename order — the
  // scarce comment budget must land on the angles whose omitted findings
  // carry the most decision weight, not on whichever angle happens to sort
  // first alphabetically. Ties break by index, so the order stays
  // deterministic. Angles already seeded with their real findings above hold
  // their ideal shape already and are excluded — there is nothing "up" from
  // real to upgrade to.
  const upgradeOrder = findingsJson
    .map((_, i) => i)
    .filter((i) => findingsJson[i].findings.length > 0 && marked[i] === bareMarkers[i])
    .sort((i, j) => angleWorstSeverityRank(findingsJson[i]) - angleWorstSeverityRank(findingsJson[j]) || i - j);
  for (const i of upgradeOrder) {
    const bare = marked[i];
    // Try the angle's real findings first — the PRE-SHRINK original, not the
    // already-summary-floor-shrunk findingsJson (fitFindingsToRenderBudget
    // mutated that array in place trying to fit the whole round, so by the
    // time we get here every summary is already crushed to the minimum
    // length; offering that as "real" would let a marker-tier round replace
    // a must-fix angle's readable finding with an unreadable 31-char stub
    // even when ~1750 chars of budget are unused) — then the shrunk form,
    // then the verbose marker, keeping the first candidate that still lets
    // the WHOLE round render; fall back to bare when none fit.
    let upgraded = false;
    for (const candidate of [originalFindingsJson[i], findingsJson[i], buildAngleMarker(findingsJson[i], true)]) {
      marked[i] = candidate;
      if (fitsRenderBudget(marked)) {
        upgraded = true;
        break;
      }
    }
    if (!upgraded) {
      marked[i] = bare; // neither this angle's real findings nor its verbose breakdown fit — keep it bare
    }
  }
  return { commentFindingsJson: marked, withheldOut: false };
}

// Bound to write-gate-findings-log.mjs's OWN carriedFromHead validation
// (--provenance.perAngle[].carriedFromHead) so the two provenance surfaces
// agree on what a head SHA is (worth-fixing-now: a prior version accepted any
// non-empty string here and stamped it verbatim into "angles"/"findingsJson").
const CARRIED_FROM_HEAD_RE = /^[0-9a-f]{7,64}$/i;

// Normalize a candidate head SHA (flag value or artifact stamp): trim+lowercase,
// null when not a 7-64 char hex string.
function normalizeHeadShaValue(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return CARRIED_FROM_HEAD_RE.test(normalized) ? normalized : null;
}

// Validate + normalize (in place) a "carried" entries array's per-entry shape:
// a non-empty "angle" and a "carriedFromHead" that is a 7-64 char hex SHA.
// Shared by BOTH the parse-time path (validateCarryForwardPlanShape, below) and
// consolidateGateFanin's own re-check of options.carryForwardPlan (coverage:
// a programmatic caller that bypasses the parser was previously re-checked
// only for PRESENCE of a carryForwardPlan array, never entry SHAPE, so e.g.
// `[{ angle: "x" }]` — missing carriedFromHead entirely — minted an unmarked
// clean row indistinguishable from a fresh review instead of failing closed).
function validateCarryForwardPlanEntries(carried) {
  carried.forEach((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
        || typeof entry.angle !== "string" || entry.angle.trim().length === 0
        || typeof entry.carriedFromHead !== "string") {
      throw new Error(`--carry-forward-plan carried[${i}] must be an object with non-empty string "angle" and "carriedFromHead" fields (resolve-angle-carry-forward.mjs's plan.carried shape)`);
    }
    const normalized = entry.carriedFromHead.trim().toLowerCase();
    if (!CARRIED_FROM_HEAD_RE.test(normalized)) {
      throw new Error(`--carry-forward-plan carried[${i}].carriedFromHead must be a 7-64 char hex SHA (write-gate-findings-log.mjs's own provenance bound), got ${JSON.stringify(entry.carriedFromHead)}`);
    }
    entry.carriedFromHead = normalized;
  });
  return carried;
}

// Validate --carry-forward-plan's shape at parse time: an object carrying a
// "carried" array (resolve-angle-carry-forward.mjs's own result object
// satisfies this directly — its top-level "carried" field), OR a bare JSON
// array of carried entries (contract-surface: the shipped Phase 3 procedure,
// this CLI's own --help, and its error text all documented that shorthand as
// accepted while the code rejected it outright — normalizing the bare-array
// case here makes the documented shorthand true, which is less churn than
// rewriting four doc/error-text sites to instead demand the full wrapper) —
// so the sanctioned invocation can pass that CLI's stdout, or just its
// "carried" field, straight through. Every entry must carry a non-empty
// "angle" and a "carriedFromHead" that is a 7-64 char hex SHA (the two fields
// --carried-angles's validation and the carriedFromHead stamping below both
// need) — malformed/missing evidence fails closed HERE rather than silently
// treating an unmatched name as "not carried" later, or a garbage provenance
// marker reaching --out.
// Returns the validated "carried" array (not the whole plan object) — the
// only part consolidateGateFanin actually consumes.
function validateCarryForwardPlanShape(raw) {
  const plan = Array.isArray(raw) ? { carried: raw } : raw;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error('--carry-forward-plan must be a JSON object with a "carried" array, or a bare JSON array of carried entries (resolve-angle-carry-forward.mjs\'s own result, or just its "carried" field)');
  }
  if (!Array.isArray(plan.carried)) {
    throw new Error('--carry-forward-plan must have a "carried" array (resolve-angle-carry-forward.mjs\'s plan.carried)');
  }
  return validateCarryForwardPlanEntries(plan.carried);
}

export function parseConsolidateFaninCliArgs(argv) {
  const options = {
    help: false,
    findingsDir: undefined,
    headSha: undefined,
    gate: undefined,
    out: undefined,
    ledgerOut: undefined,
    prChecklistMatrix: undefined,
    carriedAngles: undefined,
    carryForwardPlan: undefined,
    repoRoot: undefined,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      "findings-dir": { type: "string" },
      "head-sha": { type: "string" },
      gate: { type: "string" },
      out: { type: "string" },
      "ledger-out": { type: "string" },
      "pr-checklist-matrix": { type: "string" },
      "carried-angles": { type: "string" },
      "carry-forward-plan": { type: "string" },
      "repo-root": { type: "string" },
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
    if (token.name === "findings-dir") {
      options.findingsDir = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "head-sha") {
      const headSha = normalizeHeadShaValue(requireTokenValue(token, parseError));
      if (headSha === null) {
        throw parseError("--head-sha must be a 7-64 char hex SHA");
      }
      options.headSha = headSha;
      continue;
    }
    if (token.name === "gate") {
      const gate = requireTokenValue(token, parseError).trim();
      if (!VALID_GATES.has(gate)) {
        throw parseError("--gate must be draft_gate or pre_approval_gate");
      }
      options.gate = gate;
      continue;
    }
    if (token.name === "out") {
      const out = requireTokenValue(token, parseError).trim();
      if (out.length === 0) {
        throw parseError("--out requires a non-empty path");
      }
      options.out = out;
      continue;
    }
    if (token.name === "ledger-out") {
      const ledgerOut = requireTokenValue(token, parseError).trim();
      if (ledgerOut.length === 0) {
        throw parseError("--ledger-out requires a non-empty path");
      }
      options.ledgerOut = ledgerOut;
      continue;
    }
    if (token.name === "pr-checklist-matrix") {
      options.prChecklistMatrix = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "carried-angles") {
      const raw = requireTokenValue(token, parseError);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw parseError("--carried-angles must be a JSON array of angle-name strings");
      }
      if (!Array.isArray(parsed) || parsed.some((a) => typeof a !== "string" || a.trim().length === 0)) {
        throw parseError("--carried-angles must be a JSON array of non-empty angle-name strings");
      }
      options.carriedAngles = parsed.map((a) => a.trim());
      continue;
    }
    if (token.name === "carry-forward-plan") {
      const raw = requireTokenValue(token, parseError);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw parseError("--carry-forward-plan must be JSON");
      }
      try {
        options.carryForwardPlan = validateCarryForwardPlanShape(parsed);
      } catch (err) {
        throw parseError(err instanceof Error ? err.message : String(err));
      }
      continue;
    }
    if (token.name === "repo-root") {
      const repoRoot = requireTokenValue(token, parseError).trim();
      if (repoRoot.length === 0) {
        throw parseError("--repo-root requires a non-empty path");
      }
      options.repoRoot = repoRoot;
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (!options.findingsDir) {
    throw parseError("Missing required argument: --findings-dir <dir>");
  }
  // --carried-angles is proof-carrying, not a bare trust-me list (must-fix
  // regression: a mandatory angle or a fabricated name could otherwise mint a
  // clean per-angle entry with no reviewer ever having run). It REQUIRES
  // --carry-forward-plan (the evidence it is checked against, below) and
  // --gate (so the gate's configured mandatory angles can be rejected) — fail
  // closed here, at parse time, rather than deep inside consolidateGateFanin.
  if (options.carriedAngles !== undefined && options.carryForwardPlan === undefined) {
    throw parseError("--carried-angles requires --carry-forward-plan (resolve-angle-carry-forward.mjs's own result) as proof — refusing to mint a carried entry from a bare name with no cross-check");
  }
  if (options.carryForwardPlan !== undefined && options.carriedAngles === undefined) {
    throw parseError("--carry-forward-plan was given without --carried-angles — nothing to check it against");
  }
  if (options.carriedAngles !== undefined && options.gate === undefined) {
    throw parseError("--carried-angles requires --gate — the gate's configured mandatory angles must be checked before any angle is carried");
  }
  // The withheld tier writes --ledger-out first, then rm()s --out; the
  // under-budget path writes --ledger-out and then overwrites --out. Either
  // way the same resolved path for both flags means one write destroys the
  // other, and the CLI still returns ok:true — a success envelope over zero
  // durable evidence. Compare resolved (path.resolve) paths, not raw
  // strings, so "./x.json" vs "x.json" is caught too.
  if (options.out !== undefined && options.ledgerOut !== undefined
      && path.resolve(options.out) === path.resolve(options.ledgerOut)) {
    throw parseError("--out and --ledger-out must not resolve to the same path");
  }
  // Neither --out nor --ledger-out may resolve to a DIRECT TOP-LEVEL sibling
  // of --findings-dir's own artifacts: the withheld tier rm()s --out outright
  // (so an --out aliased to a reviewer artifact would be deleted, not merely
  // overwritten), and a plain --out/--ledger-out write there with a .json name
  // poisons the NEXT consolidation of the same directory (it gets picked up as
  // a per-angle findings artifact, failing with a misleading "artifact must be
  // a JSON object" — it's a findings array, not one). Artifact discovery is
  // top-level-only (readdir above is not recursive), so only the exact parent
  // directory is the hazard — a path in a SUBdirectory of --findings-dir can
  // never be re-read as an artifact and must stay allowed (this module's own
  // tests write --out to `<findingsDir>/out/findings.json`).
  const resolvedFindingsDir = path.resolve(options.findingsDir);
  for (const [flag, value] of [["--out", options.out], ["--ledger-out", options.ledgerOut]]) {
    if (value !== undefined && path.dirname(path.resolve(value)) === resolvedFindingsDir) {
      throw parseError(`${flag} must not resolve to a direct sibling of the artifacts inside --findings-dir "${options.findingsDir}"`);
    }
  }
  return options;
}

// Validate the CLI's own fail-closed schema floor: a well-formed object with a
// non-empty angle, a non-empty verdict, and (when findings is present as an
// array) only recognized severities. Everything else — verdict enum value,
// findings/clean-vs-findings_present consistency, missing summary — is left
// to consolidateFanin()'s own malformed-input handling; a consolidation it
// marks blocked then FAILS CLOSED below (exit 1) rather than emitting any
// findings shape, so this stays a thin floor rather than a second copy of
// consolidateFanin()'s validation.
//
// must-fix (input-validation): "carriedFromHead" is a PRODUCER field this CLI
// stamps itself, inside the --carried-angles block below, on a synthetic entry
// IT constructs — never a field a per-angle findings artifact is entitled to
// self-declare. Without this check, --findings-dir/<any *.json> is the least
// trusted input in the whole flow (subagent-written, glob-discovered) and a
// file that simply includes "carriedFromHead" would flow it straight through
// to "angles"/"findingsJson" at exit 0 even with NO --carried-angles at all —
// bypassing both the mandatory/ALWAYS_INCLUDE and carry-forward-plan proof
// guards entirely, and exempting that angle from gate-fanin's
// one-scoped-reviewer-per-fresh-angle coverage check downstream. Refuse it
// loudly rather than silently stripping it: a fresh reviewer artifact
// self-declaring carried provenance is itself evidence something is wrong
// (a copy-pasted fixture, a compromised/confused reviewer), not a value to
// quietly discard.
function validateArtifactShape(raw, sourceLabel) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${sourceLabel}: artifact must be a JSON object`);
  }
  if (typeof raw.angle !== "string" || raw.angle.trim().length === 0) {
    throw new Error(`${sourceLabel}: missing "angle"`);
  }
  if (typeof raw.verdict !== "string" || raw.verdict.trim().length === 0) {
    throw new Error(`${sourceLabel}: missing "verdict"`);
  }
  if (raw.carriedFromHead !== undefined) {
    throw new Error(`${sourceLabel}: must not declare "carriedFromHead" — that field is stamped only by this CLI's own --carried-angles/--carry-forward-plan proof check, never self-reported by a per-angle findings artifact (fail-closed)`);
  }
  if (Array.isArray(raw.findings)) {
    raw.findings.forEach((f, i) => {
      if (f && typeof f === "object" && !Array.isArray(f) && typeof f.severity === "string" && !VALID_SEVERITIES.has(f.severity.trim())) {
        throw new Error(`${sourceLabel}: findings[${i}] has unknown severity "${f.severity}" (expected must-fix|worth-fixing-now|defer)`);
      }
    });
  }
}

// Resolve the --pr-checklist-matrix upsert value: only the literal "clean"
// keyword is accepted (the mandatory-angle convenience). AC1 only requires
// upserting the mandatory clean entry when nothing covers it; no documented
// caller ever passes a custom artifact, so that speculative surface is not
// offered.
function resolvePrChecklistMatrixUpsert(rawValue) {
  if (rawValue.trim().toLowerCase() !== "clean") {
    throw new Error('--pr-checklist-matrix accepts only "clean"');
  }
  return { angle: FANIN_SYNTHETIC_ANGLES[0], verdict: "clean", findings: [] };
}

export async function consolidateGateFanin(options) {
  // Re-normalize/validate headSha here, not only in the CLI parser: a direct
  // programmatic caller bypasses parseConsolidateFaninCliArgs, and an
  // un-normalized (uppercase/padded) value would spuriously mismatch a
  // correctly-stamped artifact — same parser-bypass hardening the
  // carried-angles proof below already gets.
  if (options.headSha !== undefined) {
    const headSha = normalizeHeadShaValue(options.headSha);
    if (headSha === null) {
      throw new Error(`--head-sha must be a 7-64 char hex SHA string, got ${JSON.stringify(options.headSha)}`);
    }
    options = { ...options, headSha };
  }
  const dir = options.findingsDir;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`--findings-dir "${dir}" could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  // A per-angle artifact SYMLINKED into --findings-dir (a reviewer writing via
  // a symlink) must resolve like a regular file, not vanish silently: readdir
  // reports a symlink as isSymbolicLink(), never isFile(), so a bare isFile()
  // filter drops it with no warning — the exact fail-open this tool exists to
  // prevent, reached through a different input path than the blocked-verdict
  // guard below. stat() (which follows symlinks) each *.json dirent instead;
  // fail closed, naming the entry, on anything that isn't a regular file or a
  // symlink resolving to one (a dangling symlink, a directory, a fifo, ...).
  const jsonEntries = entries.filter((e) => e.name.endsWith(".json"));
  const files = [];
  for (const e of jsonEntries) {
    const entryPath = path.join(dir, e.name);
    if (e.isFile()) {
      files.push(e.name);
      continue;
    }
    if (e.isSymbolicLink()) {
      let resolved;
      try {
        resolved = await stat(entryPath);
      } catch (err) {
        throw new Error(`--findings-dir "${dir}" contains a *.json entry "${e.name}" that could not be resolved (dangling symlink?): ${err instanceof Error ? err.message : String(err)}`);
      }
      if (resolved.isFile()) {
        files.push(e.name);
        continue;
      }
      throw new Error(`--findings-dir "${dir}" contains a *.json entry "${e.name}" whose symlink target is not a regular file`);
    }
    const kind = e.isDirectory() ? "a directory" : e.isFIFO?.() ? "a fifo" : "not a regular file";
    throw new Error(`--findings-dir "${dir}" contains a *.json entry "${e.name}" that is ${kind}, not a regular file or a symlink to one`);
  }
  files.sort();
  // An all-carried round (Phase 1.2 carries every resolved angle, so Phase 2
  // dispatches nothing) has a legitimately empty --findings-dir — refuse it
  // only when --carried-angles ALSO has nothing to fill it with, so this
  // guard still catches the real mistake (an empty dir with no carry plan at
  // all) without blocking the feature's own maximum-saving case.
  if (files.length === 0 && (options.carriedAngles?.length ?? 0) === 0) {
    throw new Error(`--findings-dir "${dir}" contains no *.json findings artifacts`);
  }

  // Head-stamp exemption membership: EXACT declared carried names, normalized
  // trim+lowercase only. Deliberately NOT baseAngleName-collapsed — a
  // -delta-at-<sha> sibling is an independently reviewed row, and collapsing
  // would exempt a fresh sibling's stale artifact because its BASE was carried
  // (fail-open). The carried-upsert path's base-name matching answers a
  // different question (does a real artifact cover the carried slot).
  const exemptCarriedKeys = new Set((options.carriedAngles ?? []).map((a) => String(a).trim().toLowerCase()));

  const rawArtifacts = [];
  const angleSourceFiles = new Map(); // angle -> file paths that declared it
  for (const name of files) {
    const filePath = path.join(dir, name);
    let text;
    try {
      text = await readFile(filePath, "utf8");
    } catch (err) {
      throw new Error(`Cannot read findings artifact "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Findings artifact "${filePath}" is not valid JSON`);
    }
    validateArtifactShape(parsed, `"${filePath}"`);
    const angle = parsed.angle.trim();
    // Head-stamp guard: with --head-sha, an artifact must prove it was written
    // against THIS round's head. A stale copy staged from an earlier round is
    // otherwise indistinguishable from a fresh verdict — it would re-raise
    // already-fixed findings or, worse, vouch clean for code its reviewer never
    // saw. A declared carried-forward angle is exempt (the plan-proven
    // --carried-angles declaration is the operator's explicit provenance; the
    // ledger's carriedFromHead stays the single provenance field), and so is a
    // "blocked" artifact — a refusing reviewer's shape carries no stamp, and
    // the blocked-verdict fail-closed path below owns that failure with its
    // actionable re-run message. A missing or malformed stamp on any other
    // artifact is UNKNOWN provenance and fails closed the same way as a
    // mismatch, so omitting the field never bypasses the guard.
    if (options.headSha !== undefined
        && parsed.verdict.trim() !== "blocked"
        && !exemptCarriedKeys.has(angle.toLowerCase())) {
      const stamp = normalizeHeadShaValue(parsed.headSha);
      if (stamp === null) {
        throw new Error(`"${filePath}": angle "${angle}" has no valid "headSha" stamp (unknown provenance) — required when consolidating with --head-sha ${options.headSha}, unless the angle is declared in --carried-angles`);
      }
      if (stamp !== options.headSha) {
        throw new Error(`"${filePath}": angle "${angle}" is stamped for head ${stamp} but this round consolidates head ${options.headSha} — a stale artifact must not pass as a fresh verdict; re-run the angle or declare it carried forward via --carried-angles/--carry-forward-plan`);
      }
    }
    if (!angleSourceFiles.has(angle)) angleSourceFiles.set(angle, []);
    angleSourceFiles.get(angle).push(filePath);
    rawArtifacts.push(parsed);
  }

  // Duplicate angle name across two artifact files is an ambiguous fan-out
  // (which one is authoritative?) — without this guard, findingsJson would
  // duplicate that angle's findings into EVERY matching section while the
  // flat findings/ledger shape counts them once, silently inflating counts.
  // Fail closed instead, naming every offending angle + its source files.
  const duplicateAngles = [...angleSourceFiles.entries()].filter(([, paths]) => paths.length > 1);
  if (duplicateAngles.length > 0) {
    const detail = duplicateAngles
      .map(([angle, paths]) => `"${angle}" declared in ${paths.join(", ")}`)
      .join("; ");
    throw new Error(`--findings-dir "${dir}" has duplicate angle name(s) across multiple artifact files (ambiguous fan-out): ${detail}`);
  }

  if (options.prChecklistMatrix !== undefined) {
    const hasPrChecklistMatrix = rawArtifacts.some(
      (a) => typeof a.angle === "string" && a.angle.trim() === FANIN_SYNTHETIC_ANGLES[0],
    );
    if (!hasPrChecklistMatrix) {
      rawArtifacts.push(resolvePrChecklistMatrixUpsert(options.prChecklistMatrix));
    }
  }

  // Load this worktree's config to resolve the gate's configured blocking
  // severities when --gate is supplied, so the overall verdict honors e.g. a
  // repo that also blocks clean on worth-fixing-now. Without --gate, keep
  // consolidateFanin's own ["must-fix"] default (no config side effects).
  // --repo-root anchors this explicitly (default process.cwd()) so the overall
  // verdict is deterministic regardless of the CLI's invocation directory.
  // Loaded HERE (before the --carried-angles block below) because that block
  // also needs this same config's mandatory-angle contract.
  let blockCleanOnFindingSeverities;
  let mandatoryAngles; // raw configured mandatory-angle names (resolveGateAngleContract) — only set when --gate is given; fed to angleReviewSurface's alwaysRerun below
  if (options.gate !== undefined) {
    const repoRoot = options.repoRoot ?? process.cwd();
    // A nonexistent/non-directory root would make loadDevLoopConfig silently
    // fall back to shipped defaults — the exact clean-ward fail-open
    // --repo-root exists to remove. Fail closed instead.
    const rootStat = await stat(repoRoot).catch(() => null);
    if (!rootStat?.isDirectory()) {
      throw new Error(`--repo-root ${JSON.stringify(repoRoot)} is not an existing directory`);
    }
    const { config, errors } = await loadDevLoopConfig({ repoRoot });
    // loadDevLoopConfig never throws: on a parse/validation failure it still
    // returns `config` merged from the shipped defaults, silently REPLACING
    // this worktree's real gates.<gate>.blockCleanOnFindingSeverities with
    // ["must-fix"]. Since --gate was given specifically to honor that
    // config, a failed load must fail closed here rather than silently
    // emitting a verdict computed from the wrong severities.
    if (Array.isArray(errors) && errors.length > 0) {
      throw new Error(`--gate ${options.gate} was given but this worktree's config (--repo-root ${JSON.stringify(repoRoot)}) could not be fully loaded/validated: ${JSON.stringify(errors)}`);
    }
    const gateKey = options.gate === "draft_gate" ? "draft" : "preApproval";
    blockCleanOnFindingSeverities = resolveGateConfig(config, gateKey).blockCleanOnFindingSeverities;
    // Lowercased to match the base+lowercase key compared against alwaysRerun
    // below — a mandatory angle configured with case drift (e.g. "Correctness")
    // must be refused exactly like its lowercase form.
    mandatoryAngles = resolveGateAngleContract(config, gateKey).mandatoryAngles.map((name) => String(name).trim().toLowerCase());
  }

  // A carried angle (Phase 1.2's plan.carried) got no Phase 2 artifact — upsert
  // its clean entry the same way --pr-checklist-matrix does, so it is not
  // invisible to findingsJson/checkFanoutAngleCoverage/the posted verdict
  // comment. A REAL artifact for that angle always wins (e.g. Phase 1 resolved
  // it fresh for the first time this head even though a stale plan still named
  // it) — this only fills a gap, never overrides. Matched by baseAngleName +
  // lowercase (not exact string) — same normalization
  // resolve-angle-carry-forward.mjs's own attribution uses — so a real
  // artifact named `<angle>-delta-at-...` or spelled with different case
  // still suppresses the synthetic upsert rather than duplicating the angle.
  //
  // must-fix (gate-evidence/correctness): --carried-angles is NOT trusted bare.
  // Every name is checked against TWO independent sources of truth before it is
  // allowed to mint a clean entry — parseConsolidateFaninCliArgs already
  // requires both to be present alongside --carried-angles, and a programmatic
  // caller that bypasses the parser is re-checked here so this function stays
  // fail-closed on its own:
  //   1. angleReviewSurface(...).kind !== "kinds" — the SAME predicate
  //      resolve-angle-carry-forward.mjs's own producer (buildCarryForwardPlan
  //      -> resolveCarryForwardAngles) uses to decide plan.carried membership,
  //      fed --gate's configured mandatoryAngles as alwaysRerun. This refuses a
  //      configured mandatory angle ("kind: always" via alwaysRerun), a
  //      hardcoded ALWAYS_INCLUDE angle — gate-evidence/renderer-security/
  //      pr-description — ("kind: always" unconditionally, independent of any
  //      config), AND an unmapped/unknown angle ("kind: unknown") in one seam,
  //      so this check and the producer's own rule can never drift apart
  //      (checking only the configured mandatory set, as a prior version did,
  //      missed the hardcoded ALWAYS_INCLUDE angles entirely).
  //   2. --carry-forward-plan's own "carried" list — the proof that this
  //      angle really was resolved as carried, not just typed in.
  if (options.carriedAngles !== undefined) {
    if (!mandatoryAngles) {
      throw new Error("--carried-angles requires --gate — the gate's configured mandatory angles must be checked before any angle is carried (fail-closed)");
    }
    const planCarried = Array.isArray(options.carryForwardPlan) ? options.carryForwardPlan : null;
    if (!planCarried) {
      throw new Error("--carried-angles requires --carry-forward-plan (resolve-angle-carry-forward.mjs's own result) as proof — refusing to mint a carried entry from a bare name with no cross-check (fail-closed)");
    }
    // coverage: re-validate entry SHAPE here too, not just presence of the
    // array — a programmatic caller of consolidateGateFanin bypasses
    // parseConsolidateFaninCliArgs (and its validateCarryForwardPlanShape call)
    // entirely, so a malformed plan entry must still fail closed with this
    // module's own message rather than an incidental TypeError three lines
    // down (or, for a missing carriedFromHead specifically, silently minting
    // an unmarked "clean" row indistinguishable from a fresh review).
    validateCarryForwardPlanEntries(planCarried);
    // Keyed on the EXACT trimmed angle name, not base+lowercase: the presence
    // proof means "the plan carried THIS name". A base-collapsed key let a
    // carried sibling (coverage vs coverage-delta-at-<sha>) vouch for a name
    // the plan never carried, minting an unreviewed synthetic clean entry.
    const planByName = new Map();
    for (const entry of planCarried) {
      const name = entry.angle.trim();
      if (!planByName.has(name)) planByName.set(name, entry);
    }
    // Suppression is checked against REAL artifacts ONLY (a fixed snapshot
    // taken before this loop runs), never against a sibling --carried-angles
    // entry: two distinct carried names sharing a base+lowercase key (e.g.
    // "coverage" and its legitimate "coverage-delta-at-<sha>" sibling) are both
    // independently carry-forward-eligible rows and must both upsert,
    // regardless of --carried-angles array order. Mutating this set inside the
    // loop (as a prior version did) silently dropped whichever one sorted
    // second. Carried-vs-carried dedup instead uses the EXACT (trimmed) angle
    // name, so only a literal repeated name in --carried-angles collapses.
    const realAngleKeys = new Set(rawArtifacts.map((a) => baseAngleName(a.angle.trim()).toLowerCase()));
    const seenCarriedNames = new Set();
    for (const angle of options.carriedAngles) {
      const trimmedAngle = angle.trim();
      const key = baseAngleName(trimmedAngle).toLowerCase();
      const surface = angleReviewSurface(key, { alwaysRerun: mandatoryAngles });
      if (surface.kind !== "kinds") {
        const why = surface.kind === "always"
          ? `it always re-runs (one of --gate ${options.gate}'s configured MANDATORY angles, or a hardcoded ALWAYS_INCLUDE evidence/security/description angle)`
          : "it has no declared review surface (an unmapped/unknown angle, fail-closed)";
        throw new Error(`--carried-angles names "${angle}", which can never legitimately carry forward: ${why} — resolve-angle-carry-forward.mjs can never put it in plan.carried, so refusing to mint a fabricated clean entry for it (fail-closed)`);
      }
      const planEntry = planByName.get(trimmedAngle);
      if (!planEntry) {
        throw new Error(`--carried-angles names "${angle}", which is not present in --carry-forward-plan's "carried" list — refusing to mint a carried entry with no proof it was ever carried (fail-closed)`);
      }
      if (realAngleKeys.has(key) || seenCarriedNames.has(trimmedAngle)) continue;
      seenCarriedNames.add(trimmedAngle);
      rawArtifacts.push({ angle: trimmedAngle, verdict: "clean", findings: [], carriedFromHead: planEntry.carriedFromHead });
    }
  }

  const angles = rawArtifacts.map((a) => ({
    angle: a.angle.trim(),
    verdict: a.verdict.trim(),
    findingCount: Array.isArray(a.findings) ? a.findings.length : 0,
    ...(typeof a.carriedFromHead === "string" ? { carriedFromHead: a.carriedFromHead } : {}),
  }));

  const consolidated = consolidateFanin({ angleResults: rawArtifacts, blockCleanOnFindingSeverities });
  // Bound each finding's free-text fields before they reach either output
  // shape — see MAX_FINDING_TEXT_LENGTH above.
  for (const f of consolidated.findings) {
    f.summary = truncateFindingText(f.summary);
    if (f.recommendation) f.recommendation = truncateFindingText(f.recommendation);
    if (f.file) f.file = truncateFindingText(f.file, MAX_FINDING_FILE_LENGTH);
  }
  // toFindingsLogShape's output ({ severity, angle, summary, disposition?, files? })
  // is exactly both write-gate-findings-log.mjs's --findings shape and the flat
  // per-finding shape upsert-checkpoint-verdict.mjs's --findings-json accepts —
  // the same array satisfies both consumer contracts.
  const findings = toFindingsLogShape(consolidated.findings);
  // The NESTED per-angle shape upsert-checkpoint-verdict.mjs's --findings-json
  // natively accepts (normalizeStructuredFindings/checkFanoutAngleCoverage): one
  // section per source artifact — including clean angles with an empty findings
  // array — so an all-clean fan-out and mandatory-angle coverage both validate.
  const findingsByAngle = new Map();
  for (const f of consolidated.findings) {
    if (!findingsByAngle.has(f.angle)) findingsByAngle.set(f.angle, []);
    findingsByAngle.get(f.angle).push(f);
  }
  // Fail closed on a blocked consolidation BEFORE deriving the nested shape:
  // consolidateFanin() returns blocked with an EMPTY findings array whenever
  // any artifact is malformed or itself blocked, so deriving per-angle
  // verdicts from that array would emit an all-clean findingsJson that
  // upsert-checkpoint-verdict accepts verbatim — silently discarding real
  // findings. A blocked fan-in has no publishable consolidated shape; the
  // caller must fix/re-run the offending reviewer first.
  if (consolidated.verdict === "blocked") {
    const detail = Array.isArray(consolidated.malformed) && consolidated.malformed.length > 0
      ? consolidated.malformed
          .map(({ index, reason }) => {
            const artifact = rawArtifacts[index];
            const angle = artifact?.angle ?? `artifact[${index}]`;
            // A "blocked" verdict is a LEGAL artifact shape (a reviewer's
            // documented signal that its review is contaminated/incomplete),
            // not a schema violation. gate-fanin's validateAngleResult only
            // knows the enum clean|findings_present, so it reports this case
            // as "invalid verdict" — steering an operator toward "fixing" it
            // by rewriting blocked -> clean instead of re-running the
            // reviewer. Detect it here and say what actually happened.
            if (artifact && typeof artifact === "object" && artifact.verdict === "blocked") {
              return `${angle}: reported verdict "blocked" — re-run that reviewer, then re-consolidate`;
            }
            return `${angle}: ${reason}`;
          })
          .join("; ")
      : "one or more per-angle artifacts report a blocked verdict";
    throw new Error(`fan-in is blocked — refusing to emit a consolidated findings shape (${detail})`);
  }

  // --ledger-out is the durable, always-complete audit trail and must land on
  // disk before ANY throw-capable step runs against it — not just --out's own
  // I/O (EISDIR/EEXIST/EACCES on a bad caller-supplied path), but also the
  // render-budget computation below: fitFindingsToRenderBudget/
  // buildBudgetMarkedFindingsJson call fitsRenderBudget, which deliberately
  // RETHROWS any non-length-bound error (a shape/schema throw out of
  // normalizeStructuredFindings/renderStructuredFindings). "findings" is
  // final at this point (the blocked-verdict guard above already ran), so
  // writing here is the latest point that still precedes every remaining
  // throw in this function (see the --ledger-out doc above: "ALWAYS complete
  // (never budgeted)").
  if (options.ledgerOut !== undefined) {
    await mkdir(path.dirname(options.ledgerOut), { recursive: true });
    await writeFile(options.ledgerOut, `${JSON.stringify(findings, null, 2)}\n`, "utf8");
  }

  const findingsJson = rawArtifacts.map((a) => {
    const angle = a.angle.trim();
    const angleFindings = findingsByAngle.get(angle) ?? [];
    return {
      angle,
      verdict: angleFindings.length > 0 ? "findings_present" : "clean",
      findings: angleFindings.map((f) => {
        const entry = { severity: f.severity, summary: f.summary, disposition: f.disposition };
        if (f.file) entry.file = f.file;
        if (typeof f.line === "number") entry.line = f.line;
        if (f.recommendation) entry.recommendation = f.recommendation;
        return entry;
      }),
      // Marks a --carried-angles upsert (a prior clean verdict, not a fresh
      // review at this head) so a reader of --out/the emitted result — not
      // just the ledger's provenance.perAngle — can tell carried from fresh.
      // upsert-checkpoint-verdict.mjs's buildAngleSectionFromNested only reads
      // angle/verdict/findings, so this extra field never affects the
      // rendered gate comment.
      ...(typeof a.carriedFromHead === "string" ? { carriedFromHead: a.carriedFromHead } : {}),
    };
  });

  // Snapshot BEFORE fitFindingsToRenderBudget mutates findingsJson in place
  // (it shrinks every summary evenly, in-place, chasing the whole-round
  // budget) — buildBudgetMarkedFindingsJson needs the pristine, un-shrunk
  // findings as its tier-1 "real" candidate; the post-shrink array alone
  // would only ever offer an already-floor-shrunk stub.
  const originalFindingsJson = structuredClone(findingsJson);
  const wholeRoundFits = fitFindingsToRenderBudget(findingsJson);
  let commentFindingsJson = findingsJson;
  let withheldOut = false;
  if (!wholeRoundFits) {
    // A degraded round's only durable record is --ledger-out (the marker text
    // in "findingsJson"/--out names the machine-local findings ledger, and
    // tier 4 writes no --out file at all). Without --ledger-out nothing
    // durable lands on disk — the full findings exist only on this process's
    // stdout, which the sanctioned ledger/post path cannot consume — exactly
    // the "success envelope over zero durable evidence" this CLI's own guards
    // elsewhere exist to prevent — so fail closed here instead of returning
    // ok:true, naming the round size so the caller knows to re-run with
    // --ledger-out rather than just guessing.
    if (options.ledgerOut === undefined) {
      throw new Error(
        `fan-in round (${findingsJson.length} angles) is over the gate-comment render budget and would degrade "findingsJson"/--out, but --ledger-out was not given — re-run with --ledger-out <path> so the round's findings are not lost`,
      );
    }
    ({ commentFindingsJson, withheldOut } = buildBudgetMarkedFindingsJson(findingsJson, originalFindingsJson));
  }

  const result = {
    ok: true,
    ...(options.gate !== undefined ? { gate: options.gate } : {}),
    angles,
    findingsJson: commentFindingsJson,
    findings,
    severityCounts: consolidated.counts.bySeverity,
    overallVerdict: consolidated.verdict,
    ...(wholeRoundFits ? {} : { commentBudgetExceeded: true }),
  };

  // parseConsolidateFaninCliArgs already rejects an --out/--ledger-out pair
  // that resolves to the identical STRING, but a programmatic caller of this
  // function (e.g. a test, or another script) can skip that parser entirely,
  // and even a CLI caller can defeat a string comparison with a same-file
  // ALIAS: a case-only spelling difference on a case-insensitive filesystem
  // (APFS/NTFS default), or a symlink/hardlink. Re-check by file IDENTITY
  // here, right before the destructive --out rm/writeFile, so every caller of
  // this shared function is protected regardless of how it got here. Both
  // paths must already exist (the ledger write above, before the render-budget
  // computation, already created --ledger-out) for dev+ino to be comparable;
  // a nonexistent --out is never the same file.
  if (options.out !== undefined && options.ledgerOut !== undefined) {
    const [outStat, ledgerStat] = await Promise.all([
      stat(options.out).catch(() => null),
      stat(options.ledgerOut).catch(() => null),
    ]);
    if (outStat && ledgerStat && outStat.dev === ledgerStat.dev && outStat.ino === ledgerStat.ino) {
      throw new Error(`--out ${JSON.stringify(options.out)} and --ledger-out ${JSON.stringify(options.ledgerOut)} resolve to the same file on disk`);
    }
  }
  if (options.out !== undefined) {
    if (withheldOut) {
      // Never leave a stale --out from an earlier round on disk: a caller
      // that unconditionally reads --out (rather than checking
      // "commentBudgetExceeded") would otherwise post a PRIOR round's
      // findings as though they were this round's.
      await rm(options.out, { force: true });
    } else {
      await mkdir(path.dirname(options.out), { recursive: true });
      await writeFile(options.out, `${JSON.stringify(commentFindingsJson, null, 2)}\n`, "utf8");
    }
  }

  return result;
}

async function main() {
  let options;
  try {
    options = parseConsolidateFaninCliArgs(process.argv.slice(2));
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
    const result = await consolidateGateFanin(options);
    process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  await main();
}
