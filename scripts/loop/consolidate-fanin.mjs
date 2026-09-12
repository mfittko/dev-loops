#!/usr/bin/env node
/**
 * consolidate-fanin.mjs — CLI over @dev-loops/core/loop/gate-fanin's pure
 * helpers. Reads every per-angle findings artifact a gate-review fan-out
 * produced and consolidates them into the JSON shapes write-gate-findings-log.mjs,
 * post-gate-findings.mjs, and upsert-checkpoint-verdict.mjs accept directly.
 * "findingsJson"/--out is the NESTED per-angle shape (one section per source
 * artifact, clean angles included with an empty findings array); the stdout
 * "findings" result is the FLAT per-finding bare array, and --ledger-out
 * writes that same flat array wrapped as { overallVerdict, findings }.
 *
 * Per-angle findings artifact shape (one *.json file per angle in --findings-dir):
 *   {
 *     angle: string,
 *     verdict: "clean" | "findings_present" | "blocked",
 *     headSha: string,   // required whenever --head-sha is given (exempt: blocked / declared-carried)
 *     findings: [{ severity, summary, file?, line?, disposition?, recommendation? }]
 *   }
 * An input finding's `disposition` is IGNORED — consolidateFanin() always
 * DERIVES it from severity. A reviewer-provided `recommendation` IS carried
 * through to both output shapes unchanged (truncated only past the length cap
 * below).
 *
 * An angle reporting verdict "blocked" (or any malformed artifact) fails the
 * whole fan-in CLOSED (exit 1, naming the offending angles) rather than
 * publishing an all-clean shape that silently discards real findings. Two
 * artifacts naming the SAME angle also fail closed (ambiguous fan-out).
 *
 * The render budget applies ONLY to "findingsJson"/--out — never to
 * "findings"/--ledger-out (the durable disposition ledger, unbounded). Fit is
 * measured by actually rendering a candidate through
 * upsert-checkpoint-verdict.mjs's own normalizeStructuredFindings/
 * renderStructuredFindings and catching the length-exceeded throw, never an
 * approximated size. An over-budget round is hard-truncated (every finding's
 * summary shrunk evenly to a 16-char floor) when --ledger-out was given;
 * still too large at that floor, it is WITHHELD or FAILS CLOSED without
 * --ledger-out. Normative algorithm: Gate Review Sub-Loop Contract Phase 3
 * "Consolidation: fan-in synthesis and disposition ledger"
 * (skills/docs/gate-review-sub-loop-contract.md).
 */
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { GATE_NAMES } from "../github/_gate-names.mjs";
import { normalizeCarriedAngleElements, parseCarriedAnglesJsonArray } from "../github/_carried-angles.mjs";
import { neutralizeBareIssuePrIds } from "@dev-loops/core/github/comment-id-guard";
import { isPostedCommentLimitError, normalizeStructuredFindings, renderStructuredFindings } from "../github/upsert-checkpoint-verdict.mjs";
import { verifyBriefingPrefixesForHead } from "../github/verify-briefing-prefixes.mjs";
import { verifyDispatchPromptLayoutForHead } from "../github/verify-dispatch-prompt-layout.mjs";
import { loadDevLoopConfig, resolveGateAngleContract, resolveGateConfig } from "@dev-loops/core/config";
import { angleReviewSurface } from "@dev-loops/core/loop/gate-carry-forward";
import { FANIN_SYNTHETIC_ANGLES, SEVERITY_ORDER, VALID_SEVERITIES, baseAngleName, checkResolvedAngleEvidence, consolidateFanin, normalizeSeverity, toFindingsLogShape } from "@dev-loops/core/loop/gate-fanin";
import { enforceCacheTelemetryEvidence } from "@dev-loops/core/loop/cache-telemetry-evidence";
import { enforcePrimerEvidence } from "@dev-loops/core/loop/primer-evidence";
import { readSpecAuthorityIdentity, stampOptionalSpecAuthority } from "../lib/spec-authority-stamp.mjs";

const USAGE = `Usage: consolidate-fanin.mjs --findings-dir <dir> [--head-sha <sha>] [--gate <draft_gate|pre_approval_gate|review>] [--out <path>] [--ledger-out <path>] [--pr-checklist clean] [--carried-angles <json> --carry-forward-plan <json>] [--repo-root <path>] [--expected-dispatch-units <n>] [--tmp-root <path>] [--emit-plan <path>]
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
  --gate <draft_gate|pre_approval_gate|review>   Echoed onto the result as "gate"; also loads this
                                 worktree's config and applies gates.<gate>.blockCleanOnFindingSeverities
                                 to the overall verdict (default when omitted: ["high"]). When given,
                                 a config that could not be fully loaded/validated FAILS CLOSED (exit 1)
                                 rather than silently falling back to the shipped default severities.
  --out <path>                  Write the nested per-angle "findingsJson" shape (below) to this
                                 path as JSON — the exact input upsert-checkpoint-verdict.mjs's
                                 --findings-json accepts. A round over the gate-comment render
                                 budget has every finding's summary hard-truncated evenly (down to
                                 a 16-char floor) until it fits — never replaced with a synthetic
                                 omitted-count/ledger-pointer marker (#1942). A round still over
                                 budget even at that floor is WITHHELD (documented in the Gate
                                 Review Sub-Loop Contract's Phase 3,
                                 skills/docs/gate-review-sub-loop-contract.md): this file is
                                 REMOVED (deleted, not skipped) rather than written.
                                 --ledger-out is unaffected either way. A withheld round FAILS
                                 CLOSED (exit 1) when --ledger-out was not also given — a degraded
                                 round otherwise has no durable record of its findings anywhere.
  --ledger-out <path>            Write the { overallVerdict, findings } wrapper to this path as
                                 JSON — overallVerdict is this CLI's computed verdict (the same
                                 value reported on stdout), findings is the flat per-finding shape
                                 (the exact --findings-file input write-gate-findings-log.mjs and
                                 post-gate-findings.mjs accept). Embedding overallVerdict here
                                 lets it flow to the durable ledger (write-gate-findings-log.mjs
                                 threads it through) and on to upsert-checkpoint-verdict.mjs's
                                 enforcement (#1616) without an orchestrator hand-off — a value the
                                 orchestrator re-types as --verdict reproduces the same defect.
                                 Rejected at parse time (exit 1) when
                                 it resolves to the same path as --out — one write would otherwise
                                 destroy the other. Neither --out nor --ledger-out may resolve to a
                                 DIRECT TOP-LEVEL sibling of --findings-dir's own artifacts (also
                                 rejected at parse time, exit 1) — a withheld round deletes --out
                                 outright (so an --out aliased to a reviewer artifact would delete it),
                                 and a .json write there would be picked up as a per-angle findings
                                 artifact by the NEXT consolidation of that same directory. A path in a
                                 SUBdirectory of --findings-dir (e.g. <findings-dir>/out/findings.json)
                                 is unaffected — artifact discovery is top-level-only, so it can never
                                 be re-read as an artifact.
  --pr-checklist clean    When no pr-checklist angle artifact was found, upsert
                                 { angle: "pr-checklist", verdict: "clean", findings: [] }
  --carried-angles <json>        JSON array of angle-name strings CARRIED FORWARD from a prior clean OR
                                 findings_present head (the "angle" field of each entry in
                                 resolve-angle-carry-forward.mjs's plan.carried) rather than freshly reviewed
                                 this round — Phase 2 dispatches no artifact for them, so without this flag
                                 they are invisible to findingsJson/checkFanoutAngleCoverage and the posted
                                 verdict comment reads as a truncated fan-out instead of a full one. REQUIRES
                                 --gate and --carry-forward-plan (below) — this CLI never mints a carried
                                 entry from a bare name alone. For any named angle with no real per-angle
                                 artifact, upserts { angle, verdict, findings, carriedFromHead } (a real
                                 artifact for that angle, if present — matched by base name and
                                 case-insensitively, same rule resolve-angle-carry-forward.mjs uses — always
                                 wins; this never overrides one). "verdict"/"findings" are the plan entry's own
                                 "prevVerdict"/"findings" (issue #2017: a findings_present carry preserves its
                                 real prior open findings unchanged, so the gate still blocks on them exactly
                                 as if freshly reviewed) — a plan entry with no "prevVerdict" (a shape that
                                 predates #2017) upserts { verdict: "clean", findings: [] } as before. Same
                                 upsert semantics as --pr-checklist, generalized, plus the two guards below.
                                 FAILS CLOSED (exit 1) on any named angle whose angleReviewSurface(...).kind
                                 !== "kinds" (@dev-loops/core/loop/gate-carry-forward) — the SAME predicate
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
                                 [{ angle, carriedFromHead, reason?, reviewer?, dispatchId?, model?,
                                 prevVerdict?, findings? }] — the proof --carried-angles is checked against.
                                 prevVerdict ("clean"|"findings_present") and findings are OPTIONAL (backward
                                 compatible with a pre-#2017 plan shape); when prevVerdict is
                                 "findings_present", findings must be a non-empty array of well-formed
                                 { severity, summary, ... } objects — a findings_present entry with no
                                 findings, or a "clean" entry carrying non-empty findings, FAILS CLOSED at
                                 parse time (both directions would either drop or fabricate findings). Each
                                 entry's carriedFromHead must
                                 be a 7-64 char hex SHA (write-gate-findings-log.mjs's own provenance bound;
                                 normalized trim+lowercase). Required together with --carried-angles (given
                                 without it, or vice versa, fails closed at parse time).
  --resolved-angles <json>       JSON array of angle-name strings naming the round's FULL resolved angle
                                 set (e.g. write-gate-context.mjs's own context artifact "resolvedAngles"
                                 field) — independent of any single gate's configured MANDATORY
                                 subset. When given AND the round's computed overall verdict is "clean",
                                 every named angle must have EITHER a real per-angle artifact in
                                 --findings-dir OR a proven carry (a name also present in --carried-angles,
                                 which is only ever populated after its own --carry-forward-plan proof
                                 check above) — otherwise this FAILS CLOSED (exit 1), naming the missing
                                 angle(s) and the artifact/proof expected for each. This is the mechanical
                                 fan-in-side catch for a resolved angle left with no evidence at all — see
                                 checkResolvedAngleEvidence (@dev-loops/core/loop/gate-fanin) and the Gate
                                 Review Sub-Loop Contract's Phase 3 backstop paragraph. Optional; omitted
                                 by default (no caller supplies it yet) — the hash/mandatory-angle checks
                                 elsewhere in this pass still run either way.
  --repo-root <path>             Root used to resolve this worktree's config (loadDevLoopConfig) when
                                 --gate is given (default: process.cwd()) — makes the overall verdict
                                 deterministic regardless of the CLI's invocation directory
  --expected-dispatch-units <n>  The number of fresh dispatch units the conductor spawned reviewers for
                                 this round (groups for grouped dispatch; angle count for per-angle
                                 dispatch — write-gate-context.mjs's fanout.pendingGroups.length).
                                 Whether that already excludes carry-forward-carried angles depends on
                                 whether the Phase 1 artifact was built with write-gate-context.mjs
                                 --carried-angles: if so, pendingGroups already excludes them and needs
                                 no further subtraction; if the artifact predates that carry-forward
                                 (no --carried-angles rebuild), pendingGroups still includes the carried
                                 angles and the caller must subtract the carry-forward-carried
                                 dispatch units by hand before passing this flag. Either way, if the
                                 resulting count is 0, OMIT --expected-dispatch-units entirely rather
                                 than pass 0 (this parses as a POSITIVE integer and throws on 0).
                                 The records-floor AUTHORITY for whether units were expected at all is
                                 NOT this flag but the round's persisted request-plan artifact
                                 (#1868): when --head-sha is given, the fan-in derives the
                                 pending-angle floor from every <gate>-<headSha>.dispatch-plan.json
                                 under tmp/gate-context/** and FAILS CLOSED when the plan records
                                 pending angles but the round recorded zero reviewer sentinels —
                                 independent of this flag. This flag, when given, still reconciles the EXACT count.
                                 When given alongside --head-sha, the fan-in fails closed
                                 (GATE-EXEC-BRIEFING-PREFIX, #1618) when the reviewer sentinel count
                                 for the head is SHORT of it — a dispatched reviewer never ran the
                                 fresh-context guard. Optional; when omitted the count check is skipped
                                 (the hash checks AC1/AC2 still run). NOT fanout.wavePlan.length (that
                                 is the WAVE count, typically 1) and NOT the per-angle artifact count,
                                 which would false-fail every grouped round. Grouped dispatch writes one sentinel per
                                 GROUP reviewer, so this is the dispatch-UNIT count, NOT the per-angle
                                 artifact count — comparing against the angle count would false-fail
                                 every grouped round.
                                 When --head-sha is given, the fan-in ALSO reads any
                                 tmp/checkpoint-dispatch-prompt-<scope>-<headSha>.json records
                                 (record-dispatch-prompt-layout.mjs) and FAILS CLOSED (exit 1) when a
                                 recorded reviewer prompt does not LEAD with the round's
                                 byte-identical invariant prefix or its byte-identical pointer line
                                 (GATE-EXEC-BRIEFING-PREFIX layout, #1841/completes #1468) — an
                                 angle-first prompt fails this mechanically. A round with no such
                                 records is never newly blocked (progressive/optional capture).
  --primer-evidence <path>       The recorded primer-dispatch ordering evidence artifact
                                 (<gate>-<headSha>.primer-evidence.json, Phase 1.5 step 4) as JSON.
                                 Must be paired with --primer-plan (either flag alone fails closed at
                                 parse time). When both are given, the fan-in re-validates the
                                 evidence against the dispatch plan via enforcePrimerEvidence
                                 (GATE-EXEC-PRIMER-EVIDENCE) and FAILS CLOSED (exit 1) when the
                                 ordering barrier, request-group coverage, model-group binding,
                                 request-prefix fingerprint, shared-prefix hash, or plan hash is
                                 missing or mismatched — the refusal names the failing check.
  --primer-plan <path>           The dispatch plan (buildReviewDispatchPlan output, carrying its
                                 requestGroups / planHash / sharedPrefixHash) the evidence was
                                 derived from, as JSON. Required together with --primer-evidence.
  --cache-telemetry <path>       The before/after cache-telemetry evidence artifact
                                 (<gate>-<headSha>.cache-telemetry.json, Phase 1.5 step 5) as JSON.
                                 When given, the fan-in validates it via enforceCacheTelemetryEvidence
                                 (GATE-EXEC-CACHE-TELEMETRY) and FAILS CLOSED (exit 1) when the
                                 artifact is missing, when verified provider reuse is claimed for an
                                 opaque/unavailable-telemetry harness, when a verified result lacks a
                                 measured create-then-read sequence, or when the aggregate/token
                                 report contradicts the recorded events. Absent the flag, the fan-in
                                 proceeds unchanged (recording telemetry is progressive/optional).
  --emit-plan <path>            emit-fanout-dispatch.mjs's keyed emit-plan artifact
                                 (<gate>-<headSha>.emit-plan.json, GATE-EXEC-FANOUT-DISPATCH-EMIT) as a
                                 path. Optional; when given, the fan-in verifies the plan's embedded
                                 round key (gate, headSha) against the round being consolidated and
                                 FAILS CLOSED (exit 1, "cannot verify emit-plan key" / "is stamped for ...")
                                 on a mismatch, a missing/malformed key field, or an unreadable/non-JSON
                                 plan — BEFORE any --out/--ledger-out write. On that fail-closed
                                 path any pre-existing files at --out/--ledger-out are REMOVED, so a
                                 rejected round leaves no stale durable output for a caller to
                                 consume. REQUIRES --gate and
                                 --head-sha (the round the plan's key is verified against). A guard
                                 only: the plan is never a findings or provenance source — the
                                 gate-context bundle's fanout.groups stays authoritative.
  --tmp-root <path>              The tmp/ directory holding the reviewer sentinels and per-gate briefing-prefix
                                 records read by the briefing-prefix verification (default:
                                 process.cwd()/tmp). Sentinels are read directly from this directory
                                 (not a tmp/ subdirectory of it); per-gate records from <tmpRoot>/gate-context/**.
  --spec-authority <path>        JSON { specDigest, headSha, contentDigest, checkedCriteria }
                                 (issue 2008 / ADR 0061 AC1). When supplied, stamps the
                                 --ledger-out { overallVerdict, findings } object with the pinned
                                 revision identity via the ONE shared stamp helper. Pure no-op
                                 (byte-identical --ledger-out) when absent.
Output (stdout, JSON):
  { "ok": true, "gate"?: "...", "angles": [{ "angle", "verdict", "findingCount", "carriedFromHead"? }],
    "findingsJson": [{ "angle", "verdict", "findings": [...], "carriedFromHead"? }], "findings": [...],
    "severityCounts": { "high", "medium", "low", "question", "nit" },
    "overallVerdict": "clean"|"findings_present", "commentBudgetExceeded"?: true,
    "out"?: "<path>", "ledgerOut"?: "<path>" }
  "out"/"ledgerOut" echo the --out/--ledger-out path back onto the result ONLY when this call actually
  wrote a file there — "ledgerOut" whenever --ledger-out was given (that write always completes in
  full before any later throw in this function), "out" whenever --out was given AND the round was
  not withheld (see "commentBudgetExceeded" above) — so ONE invocation with --jq, --out, and
  --ledger-out together (e.g. --jq '.severityCounts') both writes every consumer artifact and reports
  verdict/severityCounts/where-they-landed on stdout, with no second invocation ever needed to
  re-extract a different shape or rediscover a path the caller itself just passed in.
  A "carriedFromHead" field appears ONLY on an entry --carried-angles upserted (the prior head SHA it
  was carried from, taken from --carry-forward-plan) — every freshly reviewed angle's entry omits it,
  so a consumer can distinguish a carried verdict from a fresh review without reading the ledger's
  provenance. upsert-checkpoint-verdict.mjs's renderer ignores unrecognized per-angle fields, so this
  never affects the rendered gate comment.
  "findingsJson" is the nested per-angle shape (one section per source artifact, including clean
  angles with an empty findings array) — pass --out's file straight to
  upsert-checkpoint-verdict.mjs's --findings-json. "findings" is the FLAT per-finding shape — pass
  --ledger-out's file straight to write-gate-findings-log.mjs/post-gate-findings.mjs's
  --findings-file (a { overallVerdict, findings } wrapper object — both tools
  unwrap it; write-gate-findings-log.mjs threads overallVerdict into the
  durable ledger, post-gate-findings.mjs ignores it), and is ALWAYS complete (never budgeted). "severityCounts" is likewise ALWAYS the
  true, unbudgeted totals across every finding, independent of any marking applied to "findingsJson"
  below. Every output finding's "disposition" is DERIVED from severity (accepted-for-fix for a
  blocking severity, needs-answer for a LOCATABLE question, deferred otherwise) — an input finding's own "disposition" is never honored,
  including on a budget-marker finding (below). A reviewer-provided "recommendation" is carried
  through to both shapes unchanged. A finding "summary" or "recommendation" longer than 2000 chars,
  or "file" longer than 300 chars, is truncated with a plain " …" suffix (never a "[truncated N
  chars]" marker), and "findingsJson"
  (--out) alone is bounded against upsert-checkpoint-verdict.mjs's OWN rendered-block limit — fit is
  measured by actually rendering a candidate through that CLI's normalizeStructuredFindings/
  renderStructuredFindings and catching the throw, not an approximated size. A round over that
  bound is hard-truncated (every finding's own summary shrunk evenly to a 16-char floor — never
  replaced with a synthetic omitted-count/ledger-pointer marker, #1942) and, if still over budget
  even at that floor, WITHHELD — documented in the Gate Review Sub-Loop Contract's Phase 3
  (skills/docs/gate-review-sub-loop-contract.md). "commentBudgetExceeded": true means withheld: a
  round that fits after hard truncation carries no flag at all, only shorter finding text, so the
  flag and --out's existence now agree exactly. "findings"/--ledger-out is always unaffected. NOTE: upsert-checkpoint-verdict.mjs's
  posted "Findings summary:" digest is derived from "findingsJson" (0 on a withheld round) UNLESS
  the caller also passes --findings-severity-counts with this CLI's own "severityCounts" (always
  the true, unbudgeted totals) — "findings"/--ledger-out always carries the true numbers
  regardless.
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
     malformed "carriedFromHead" (not a 7-64 char hex SHA), a malformed "prevVerdict"
     (not "clean"/"findings_present"), a "findings_present" entry with no non-empty
     well-formed "findings" array, or a "clean" entry carrying non-empty "findings"
     (issue #2017), a round still over the
     render budget at minimum summary length with --ledger-out not given, or a
     GATE-EXEC-BRIEFING-PREFIX verification failure when --head-sha is given
     (a sentinel records a divergent/missing prefix hash, the sentinel count
     is short of --expected-dispatch-units, a recorded reviewer prompt does
     not lead with the round's byte-identical prefix/pointer line, or the
     round's persisted request-plan artifact records pending angles but the
     round recorded zero reviewer sentinels — the #1868 records-floor) — #1618,
     #1841, #1868, or (with --resolved-angles
     and a "clean" verdict) a resolved angle with neither a per-angle artifact
     nor a proven carried-forward entry, or (with --emit-plan) a plan whose
     embedded (gate, headSha) key does not match the round being consolidated,
     an --emit-plan given without --gate/--head-sha, or an
     unreadable/non-JSON/missing-key --emit-plan artifact
     (which also clears any pre-existing --out/--ledger-out files)
  2  Invalid --jq filter`.trim();

const parseError = buildParseError(USAGE);

const VALID_GATES = new Set(GATE_NAMES);
// Truncated with a plain " …" suffix (never the "[truncated N chars]" marker,
// reserved for a posted comment being shortened). This per-field cap is not
// the whole story — see fitsRenderBudget below for the block-level bound.
const MAX_FINDING_TEXT_LENGTH = 2000;
// A path reference, not prose. Bounded separately from summary/recommendation
// so an oversized "file" (gate-fanin only .trim()s it) can't force a real,
// short finding into the withheld tier via fitFindingsToRenderBudget, which
// only shrinks summary.
const MAX_FINDING_FILE_LENGTH = 300;
function truncateFindingText(value, limit = MAX_FINDING_TEXT_LENGTH) {
  if (typeof value !== "string" || value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 2))} …`;
}

// Does a candidate findingsJson shape fit upsert-checkpoint-verdict.mjs's
// posted-comment render bound? Measured by RENDERING it through that CLI's own
// normalizeStructuredFindings/renderStructuredFindings and catching the
// length-exceeded throw (isPostedCommentLimitError) — never an approximated
// size, which would drift from the real renderer. A shape-drift throw
// (unrecognized items, mixed nested+flat, or an empty angle list) is not a
// budget question and must rethrow rather than degrade a producer defect into
// a withheld round. Exported so tests can drive this directly.
export function fitsRenderBudget(findingsJson) {
  try {
    renderStructuredFindings(normalizeStructuredFindings(findingsJson));
    return true;
  } catch (err) {
    if (isPostedCommentLimitError(err)) return false;
    throw err;
  }
}

// Calibration knob: the minimum a finding's summary is truncated to before a
// round is declared unrenderable — there is no marker tier to fall back to
// (see buildBudgetMarkedFindingsJson below). truncateFindingText still
// appends " …", so 16 chars still leaves a few real words legible.
const MIN_FINDING_SUMMARY_CAP = 16;

// Shrink the longest summaries evenly until the candidate actually renders —
// deterministic. Returns whether findingsJson (mutated in place) now fits; a
// non-length-bound error from fitsRenderBudget (a real shape/producer defect)
// still propagates. The durable ledger write happens before this runs (see
// the write ordering below), so a round too large to render never loses its
// ledger record.
function fitFindingsToRenderBudget(findingsJson) {
  let cap = MAX_FINDING_TEXT_LENGTH;
  while (!fitsRenderBudget(findingsJson) && cap > MIN_FINDING_SUMMARY_CAP) {
    // Clamp to the floor so halving can never overshoot below MIN_FINDING_SUMMARY_CAP.
    cap = Math.max(MIN_FINDING_SUMMARY_CAP, Math.floor(cap / 2));
    for (const a of findingsJson) {
      for (const f of a.findings) {
        f.summary = truncateFindingText(f.summary, cap);
      }
    }
  }
  return fitsRenderBudget(findingsJson);
}

// Floor reached and still over budget: fitFindingsToRenderBudget has already
// hard-truncated every finding's summary to MIN_FINDING_SUMMARY_CAP. There is
// no marker tier to degrade to — a synthetic omitted-count/ledger-pointer
// marker is invisible to a GitHub reader (the disposition ledger it would
// name lives only on the runner's disk), so it can never replace real finding
// text. Withhold to the durable ledger instead (--ledger-out is already
// complete by the time this runs).
// ponytail: absolute structural floor — hundreds of angles exceed any single
// comment even hard-truncated. Upgrade path: paginate the verdict across
// multiple comments if this ever fires in practice.
function buildBudgetMarkedFindingsJson(findingsJson) {
  if (!fitsRenderBudget(findingsJson)) {
    return { commentFindingsJson: [], withheldOut: true };
  }
  return { commentFindingsJson: findingsJson, withheldOut: false };
}

// Bound to write-gate-findings-log.mjs's own carriedFromHead validation
// (--provenance.perAngle[].carriedFromHead) so the two provenance surfaces
// agree on what a head SHA is.
const CARRIED_FROM_HEAD_RE = /^[0-9a-f]{7,64}$/i;

// Normalize a candidate head SHA (flag value or artifact stamp): trim+lowercase,
// null when not a 7-64 char hex string.
function normalizeHeadShaValue(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return CARRIED_FROM_HEAD_RE.test(normalized) ? normalized : null;
}

// Fail-closed key guard for the optional --emit-plan input
// (GATE-EXEC-FANOUT-DISPATCH-EMIT: emit-fanout-dispatch.mjs's keyed
// <gate>-<headSha>.emit-plan.json artifact). The plan's embedded round key
// (gate, headSha) must match the round being consolidated, or the plan is
// stale/foreign and must not be consumed — a clobbered or wrong-gate plan
// silently corrupts provenance while looking exactly like a success. Gate
// compare is trim+lowercase (single mismatch error per field); headSha reuses
// normalizeHeadShaValue (GATE-EXEC-ARTIFACT-HEAD-STAMP trim+lowercase
// semantics) so a case-different stamp still matches. Both gates are validated
// against VALID_GATES before comparing (non-strings fail closed; no String()
// coercion — a programmatic gate: null must never stringify into a plan stamped
// gate: "null", Copilot review round 4). Runs INSIDE
// consolidateGateFanin — not only in the parser — so a direct programmatic
// caller cannot bypass the check. Unreadable/invalid-JSON/missing-key errors
// all carry the "cannot verify emit-plan key" prefix; a mismatch carries the
// "is stamped for ... but this round consolidates ..." family the
// --cache-telemetry guard uses. A guard only: nothing from the plan flows
// into any output.
async function verifyEmitPlanKey(planPath, { gate, headSha }) {
  // The round's --gate must be a canonical supported gate (string membership in
  // VALID_GATES, no String() coercion) BEFORE any compare: a direct
  // programmatic call can pass gate: null/123, and String() coercion would
  // stringify null into "null" — which a malformed plan stamped gate: "null"
  // would then match, passing the key check with an invalid round
  // (Copilot review round 4). undefined still means the flag was never given.
  if (gate === undefined || headSha === undefined) {
    throw new Error("--emit-plan requires both --gate and --head-sha to verify the plan's embedded key against this round");
  }
  if (typeof gate !== "string" || !VALID_GATES.has(gate.trim().toLowerCase())) {
    throw new Error(`--emit-plan requires a canonical supported gate (one of: ${[...VALID_GATES].join(", ")}) to verify the plan's embedded key against, got ${JSON.stringify(gate)}`);
  }
  let text;
  try {
    text = await readFile(planPath, "utf8");
  } catch (err) {
    throw new Error(`cannot verify emit-plan key: --emit-plan "${planPath}" could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  let plan;
  try {
    plan = JSON.parse(text);
  } catch {
    throw new Error(`cannot verify emit-plan key: --emit-plan "${planPath}" is not valid JSON`);
  }
  const planGate = typeof plan?.gate === "string" ? plan.gate.trim().toLowerCase() : "";
  if (planGate.length === 0 || !VALID_GATES.has(planGate)) {
    throw new Error(`cannot verify emit-plan key: --emit-plan "${planPath}" is missing a canonical string "gate" field (one of: ${[...VALID_GATES].join(", ")}; emit-fanout-dispatch.mjs's own result object carries one), got ${JSON.stringify(plan?.gate)}`);
  }
  const planHeadSha = normalizeHeadShaValue(plan?.headSha);
  if (planHeadSha === null) {
    throw new Error(`cannot verify emit-plan key: --emit-plan "${planPath}" carries no valid "headSha" field (a 7-64 char hex SHA, emit-fanout-dispatch.mjs's own result object carries one), got ${JSON.stringify(plan?.headSha)}`);
  }
  const roundGate = gate.trim().toLowerCase();
  if (planGate !== roundGate) {
    throw new Error(`--emit-plan "${planPath}" is stamped for gate "${planGate}" but this round consolidates gate ${roundGate} — a stale or foreign emit plan must not be consumed for a different round (fail-closed)`);
  }
  if (planHeadSha !== headSha) {
    throw new Error(`--emit-plan "${planPath}" is stamped for head "${planHeadSha}" but this round consolidates head ${headSha} — a stale or foreign emit plan must not be consumed for a different round (fail-closed)`);
  }
}

// Validate + normalize (in place) a "carried" entries array's per-entry shape:
// a non-empty "angle" and a "carriedFromHead" that is a 7-64 char hex SHA.
// Shared by both the parse-time path (validateCarryForwardPlanShape, below)
// and consolidateGateFanin's own re-check of options.carryForwardPlan, so a
// programmatic caller that bypasses the parser still fails closed on a
// malformed entry (e.g. `[{ angle: "x" }]`, missing carriedFromHead) instead
// of minting an unmarked clean row indistinguishable from a fresh review.
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
    // Optional: a carried entry may declare the PRIOR verdict it is carrying
    // ("clean" or "findings_present"). Absent entirely, the upsert below
    // defaults to clean/no findings for backward compatibility with an older
    // plan shape.
    if (entry.prevVerdict !== undefined) {
      if (entry.prevVerdict !== "clean" && entry.prevVerdict !== "findings_present") {
        throw new Error(`--carry-forward-plan carried[${i}].prevVerdict must be "clean" or "findings_present", got ${JSON.stringify(entry.prevVerdict)}`);
      }
      // Fail closed both directions here, at the one place every carried
      // entry passes through: a "findings_present" carry with no findings
      // would silently drop the real findings it claims to carry, and a
      // "clean" carry smuggling non-empty findings would hide them behind an
      // approval — reject both rather than let either surface downstream
      // where the cause is harder to trace.
      if (entry.prevVerdict === "findings_present") {
        if (!Array.isArray(entry.findings) || entry.findings.length === 0) {
          throw new Error(`--carry-forward-plan carried[${i}] declares prevVerdict "findings_present" but has no non-empty "findings" array to carry — refusing to mint a findings_present carried entry with no findings (fail-closed: this would drop the very findings carry-forward exists to preserve)`);
        }
        entry.findings.forEach((f, j) => {
          if (!f || typeof f !== "object" || Array.isArray(f)
              || typeof f.severity !== "string" || !VALID_SEVERITIES.has(normalizeSeverity(f.severity.trim()))
              || typeof f.summary !== "string" || f.summary.trim().length === 0) {
            throw new Error(`--carry-forward-plan carried[${i}].findings[${j}] must be an object with a valid "severity" (${SEVERITY_ORDER.join("|")}) and a non-empty "summary"`);
          }
        });
      } else if (Array.isArray(entry.findings) && entry.findings.length > 0) {
        throw new Error(`--carry-forward-plan carried[${i}] declares prevVerdict "clean" but carries a non-empty "findings" array — a clean carry must never smuggle findings through (fail-closed)`);
      }
    } else if (entry.findings !== undefined && entry.findings !== null
        && (!Array.isArray(entry.findings) || entry.findings.length > 0)) {
      // Symmetric fail-closed case: an entry with no prevVerdict at all must
      // not be a backdoor around the check above. This also covers a
      // malformed (non-array) findings payload, not just a non-empty array —
      // only an explicit prevVerdict: "findings_present" with a well-formed
      // non-empty findings array is eligible to carry findings through.
      throw new Error(`--carry-forward-plan carried[${i}] carries a "findings" payload (${Array.isArray(entry.findings) ? "non-empty array" : typeof entry.findings}) but no "prevVerdict": "findings_present" — refusing to upsert it as a clean carry (fail-closed)`);
    }
  });
  return carried;
}

// Validate --carry-forward-plan's shape at parse time: an object carrying a
// "carried" array (resolve-angle-carry-forward.mjs's own result object
// satisfies this directly), or a bare JSON array of carried entries — so the
// sanctioned invocation can pass that CLI's stdout, or just its "carried"
// field, straight through. Every entry must carry a non-empty "angle" and a
// "carriedFromHead" that is a 7-64 char hex SHA; malformed/missing evidence
// fails closed here rather than silently treating an unmatched name as "not
// carried" later, or a garbage provenance marker reaching --out.
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
    prChecklist: undefined,
    carriedAngles: undefined,
    carryForwardPlan: undefined,
    resolvedAngles: undefined,
    repoRoot: undefined,
    expectedDispatchUnits: undefined,
    primerEvidence: undefined,
    cacheTelemetry: undefined,
    emitPlan: undefined,
    primerPlan: undefined,
    tmpRoot: undefined,
    specAuthority: undefined,
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
      "pr-checklist": { type: "string" },
      "carried-angles": { type: "string" },
      "carry-forward-plan": { type: "string" },
      "resolved-angles": { type: "string" },
      "repo-root": { type: "string" },
      "expected-dispatch-units": { type: "string" },
      "primer-evidence": { type: "string" },
      "emit-plan": { type: "string" },
      "primer-plan": { type: "string" },
      "tmp-root": { type: "string" },
      "spec-authority": { type: "string" },
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
        throw parseError(`--gate must be one of: ${GATE_NAMES.join(", ")}`);
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
    if (token.name === "pr-checklist") {
      options.prChecklist = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "carried-angles") {
      // Parse shared with write-gate-context.mjs's own --carried-angles flag
      // so the two CLIs' accepted shape and wording can never drift.
      options.carriedAngles = parseCarriedAnglesJsonArray(requireTokenValue(token, parseError), parseError);
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
    if (token.name === "resolved-angles") {
      const raw = requireTokenValue(token, parseError);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw parseError("--resolved-angles must be a JSON array of angle-name strings");
      }
      if (!Array.isArray(parsed)) {
        throw parseError("--resolved-angles must be a JSON array of non-empty angle-name strings");
      }
      options.resolvedAngles = normalizeCarriedAngleElements(
        parsed,
        () => parseError("--resolved-angles must be a JSON array of non-empty angle-name strings"),
      );
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
    if (token.name === "expected-dispatch-units") {
      const raw = requireTokenValue(token, parseError).trim();
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        throw parseError(`--expected-dispatch-units must be a positive integer (the number of fresh dispatch units the conductor spawned reviewers for this round), got ${JSON.stringify(raw)}`);
      }
      options.expectedDispatchUnits = n;
      continue;
    }
    if (token.name === "tmp-root") {
      const tmpRoot = requireTokenValue(token, parseError).trim();
      if (tmpRoot.length === 0) {
        throw parseError("--tmp-root requires a non-empty path");
      }
      options.tmpRoot = tmpRoot;
      continue;
    }
    if (token.name === "spec-authority") {
      const p = requireTokenValue(token, parseError).trim();
      if (p.length === 0) {
        throw parseError("--spec-authority requires a non-empty path");
      }
      options.specAuthority = p;
      continue;
    }
    if (token.name === "primer-evidence") {
      const p = requireTokenValue(token, parseError).trim();
      if (p.length === 0) {
        throw parseError("--primer-evidence requires a non-empty path");
      }
      options.primerEvidence = p;
      continue;
    }
    if (token.name === "primer-plan") {
      const p = requireTokenValue(token, parseError).trim();
      if (p.length === 0) {
        throw parseError("--primer-plan requires a non-empty path");
      }
      options.primerPlan = p;
      continue;
    }
    if (token.name === "cache-telemetry") {
      const p = requireTokenValue(token, parseError).trim();
      if (p.length === 0) {
        throw parseError("--cache-telemetry requires a non-empty path");
      }
      options.cacheTelemetry = p;
      continue;
    }
    if (token.name === "emit-plan") {
      const p = requireTokenValue(token, parseError).trim();
      if (p.length === 0) {
        throw parseError("--emit-plan requires a non-empty path");
      }
      options.emitPlan = p;
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (!options.findingsDir) {
    throw parseError("Missing required argument: --findings-dir <dir>");
  }
  // Primer-evidence enforcement only makes sense when both the recorded
  // evidence artifact and the dispatch plan it was derived from are present —
  // enforcePrimerEvidence needs the plan's request groups and hashes to check
  // the evidence against. Either alone fails closed here, so a caller can
  // never half-enable the gate.
  if ((options.primerEvidence === undefined) !== (options.primerPlan === undefined)) {
    throw parseError("--primer-evidence and --primer-plan must be given together: a primer-evidence artifact cannot be enforced against no plan, and a plan without its recorded evidence would silently skip the gate");
  }
  // --emit-plan pairing is NOT checked here: the pair requirement lives in
  // consolidateGateFanin's own guard (verifyEmitPlanKey), which runs on BOTH
  // entry paths. A parser-level check would fire BEFORE the guard's stale-
  // output cleanup, so a CLI round with a bare --emit-plan and pre-existing
  // --out/--ledger-out files from an earlier round would fail closed but
  // leave those stale durable outputs on disk (Copilot review round 4). The
  // guard rejects the same pairing fail-closed AND clears both stale paths.
  // --carried-angles is proof-carrying, not a bare trust-me list: a mandatory
  // angle or a fabricated name could otherwise mint a clean per-angle entry
  // with no reviewer ever having run. It requires --carry-forward-plan (the
  // evidence it is checked against, below) and --gate (so the gate's
  // configured mandatory angles can be rejected) — fail closed here, at parse
  // time, rather than deep inside consolidateGateFanin.
  if (options.carriedAngles !== undefined && options.carryForwardPlan === undefined) {
    throw parseError("--carried-angles requires --carry-forward-plan (resolve-angle-carry-forward.mjs's own result) as proof — refusing to mint a carried entry from a bare name with no cross-check");
  }
  if (options.carryForwardPlan !== undefined && options.carriedAngles === undefined) {
    throw parseError("--carry-forward-plan was given without --carried-angles — nothing to check it against");
  }
  if (options.carriedAngles !== undefined && options.gate === undefined) {
    throw parseError("--carried-angles requires --gate — the gate's configured mandatory angles must be checked before any angle is carried");
  }
  // The same resolved path for both flags means one write destroys the other
  // (the withheld tier rm()s --out then the under-budget path overwrites it),
  // and the CLI would still return ok:true over zero durable evidence.
  // Compare resolved (path.resolve) paths so "./x.json" vs "x.json" is caught.
  if (options.out !== undefined && options.ledgerOut !== undefined
      && path.resolve(options.out) === path.resolve(options.ledgerOut)) {
    throw parseError("--out and --ledger-out must not resolve to the same path");
  }
  // Neither --out nor --ledger-out may resolve to a direct top-level sibling
  // of --findings-dir's own artifacts: the withheld tier deletes --out
  // outright, and a plain write there with a .json name poisons the next
  // consolidation of the same directory (picked up as a per-angle findings
  // artifact). Artifact discovery is top-level-only, so a SUBdirectory of
  // --findings-dir stays allowed.
  const resolvedFindingsDir = path.resolve(options.findingsDir);
  for (const [flag, value] of [["--out", options.out], ["--ledger-out", options.ledgerOut]]) {
    if (value !== undefined && path.dirname(path.resolve(value)) === resolvedFindingsDir) {
      throw parseError(`${flag} must not resolve to a direct sibling of the artifacts inside --findings-dir "${options.findingsDir}"`);
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// GATE-EXEC-BRIEFING-PREFIX records-floor: the conductor's Phase-1
// request-plan artifact (`<gate>-<headSha>.dispatch-plan.json` under
// tmp/gate-context/**, written by write-gate-context.mjs) is the authority
// for whether this round dispatched units — not a caller-passed flag. Read
// every persisted request plan for the reviewed head and derive the expected
// dispatch-unit floor: the total pending angles across the plans'
// requestGroups (> 0 means zero recorded evidence must fail closed).
// Malformed/unreadable plan JSON fails closed too — a corrupt artifact means
// the enforcement authority cannot be trusted.
// ---------------------------------------------------------------------------
const REQUEST_PLAN_SUFFIX = ".dispatch-plan.json";

async function readGateRequestPlansForHead(tmpRoot, headSha) {
  const root = path.join(tmpRoot, "gate-context");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true, recursive: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const suffix = `-${headSha}${REQUEST_PLAN_SUFFIX}`;
  const matches = entries
    .filter((e) => e.isFile() && e.name.endsWith(suffix) && e.name.length > suffix.length)
    // readdir order is filesystem-dependent; sort so error messages and the
    // derived floor stay deterministic across runs.
    .sort((a, b) => a.name.localeCompare(b.name));
  const plans = [];
  for (const e of matches) {
    const gate = e.name.slice(0, -suffix.length);
    // Only canonical gate plans are trusted — same posture as the
    // briefing-prefix record reader in verify-briefing-prefixes.mjs.
    if (!GATE_NAMES.includes(gate)) continue;
    const dir = e.parentPath ?? root;
    const filePath = path.join(dir, e.name);
    let parsed;
    try {
      parsed = JSON.parse(await readFile(filePath, "utf8"));
    } catch (err) {
      throw new Error(`GATE-EXEC-BRIEFING-PREFIX records-floor (#1868): the persisted request-plan artifact "${filePath}" could not be read/parsed (${err instanceof Error ? err.message : String(err)}) — the request plan is the authority for this round's expected dispatch units, so a corrupt plan fails closed rather than passing vacuously`);
    }
    plans.push({ gate, filePath, plan: parsed });
  }
  return plans;
}

// Derive the round's records-floor input from its persisted request plans:
// the total number of PENDING ANGLES across every plan's requestGroups — a
// pending-angle floor, NOT an exact dispatch-unit count (grouped dispatch
// covers several angles per unit; --expected-dispatch-units owns the exact
// unit-count reconciliation).
// A plan whose groups carry no angles (an all-carried / genuinely zero-unit
// gate) contributes 0 — the floor only applies when units were expected.
// A parseable plan whose shape is drifted (non-array requestGroups, or a group
// with a non-array angles field) fails closed: the plan is the enforcement
// authority, so a schema-drifted or hand-edited plan must never silently
// disable the records-floor — only an empty requestGroups array
// (a genuinely zero-unit gate) contributes 0.
function deriveRequestPlanPendingAngleCount(plans) {
  let total = 0;
  for (const { filePath, plan } of plans) {
    if (!Array.isArray(plan?.requestGroups)) {
      throw new Error(`GATE-EXEC-BRIEFING-PREFIX records-floor (#1868): the persisted request-plan artifact "${filePath}" has a non-array requestGroups field (${JSON.stringify(plan?.requestGroups)}) — the plan is the enforcement authority for this round's expected dispatch units, so a shape-drifted plan fails closed rather than silently disabling the floor`);
    }
    for (const g of plan.requestGroups) {
      if (!Array.isArray(g?.angles)) {
        throw new Error(`GATE-EXEC-BRIEFING-PREFIX records-floor (#1868): the persisted request-plan artifact "${filePath}" has a requestGroup with a non-array angles field (${JSON.stringify(g?.angles)}) — the plan is the enforcement authority for this round's expected dispatch units, so a shape-drifted plan fails closed rather than silently disabling the floor`);
      }
      total += g.angles.length;
    }
  }
  return total;
}

// Validate the CLI's own fail-closed schema floor: a well-formed object with a
// non-empty angle, a non-empty verdict, and (when findings is present as an
// array) only recognized severities. Everything else is left to
// consolidateFanin()'s own malformed-input handling, which fails closed below
// on a blocked consolidation — this stays a thin floor, not a second copy of
// that validation.
//
// "carriedFromHead" is a producer field this CLI stamps itself, on a
// synthetic entry it constructs inside the --carried-angles block below —
// never a field a per-angle findings artifact is entitled to self-declare.
// Without this check, a findings artifact that simply includes
// "carriedFromHead" would flow through to "angles"/"findingsJson" with NO
// --carried-angles at all, bypassing every carry-forward proof guard. Refuse
// it loudly: a fresh reviewer artifact self-declaring carried provenance is
// itself evidence something is wrong, not a value to quietly discard.
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
      if (f && typeof f === "object" && !Array.isArray(f) && typeof f.severity === "string" && !VALID_SEVERITIES.has(normalizeSeverity(f.severity.trim()))) {
        throw new Error(`${sourceLabel}: findings[${i}] has unknown severity "${f.severity}" (expected ${SEVERITY_ORDER.join("|")})`);
      }
    });
  }
}

// Resolve the --pr-checklist upsert value: only the literal "clean" keyword
// is accepted (the mandatory-angle convenience). No documented caller ever
// passes a custom artifact, so that speculative surface is not offered.
function resolvePrChecklistUpsert(rawValue) {
  if (rawValue.trim().toLowerCase() !== "clean") {
    throw new Error('--pr-checklist accepts only "clean"');
  }
  return { angle: FANIN_SYNTHETIC_ANGLES[0], verdict: "clean", findings: [] };
}

/**
 * Clear diagnostic for a misplaced findings artifact. A fan-out reviewer
 * whose write command started in the primary checkout (cwd is not
 * trustworthy across a reviewer's commands) writes its per-angle artifact to
 * the primary checkout's tmp/ instead of this worktree's, so fan-in finds no
 * evidence in --findings-dir and fails with a confusing "missing evidence"
 * error. Resolves the primary checkout (git-common-dir's parent), checks
 * whether the same relative findings path holds stray *.json artifacts
 * there, and returns a diagnostic suffix naming the misplacement if so.
 *
 * Returns "" when repoRoot is not a linked worktree (a single-checkout run),
 * --findings-dir is not inside the worktree, git is unavailable, or no stray
 * artifacts exist. Best-effort: never throws, only enriches an error that is
 * already being raised.
 */
export async function detectMisplacedFindingsDiagnostic(findingsDir, repoRoot) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  let primaryRoot;
  try {
    let gitDir;
    try {
      gitDir = execFileSync("git", ["-C", resolvedRepoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
    } catch {
      gitDir = path.resolve(resolvedRepoRoot, execFileSync("git", ["-C", resolvedRepoRoot, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim());
    }
    primaryRoot = path.dirname(gitDir);
  } catch {
    return "";
  }
  // Single-checkout run: the primary checkout IS this checkout — nothing was
  // "misplaced" elsewhere. Compare via realpath so a symlinked tmp root
  // (macOS /var -> /private/var) does not read the same directory as two
  // different paths.
  const realOr = async (p) => { try { return await realpath(p); } catch { return path.resolve(p); } };
  if (await realOr(primaryRoot) === await realOr(resolvedRepoRoot)) return "";
  const rel = path.relative(resolvedRepoRoot, path.resolve(resolvedRepoRoot, findingsDir));
  // --findings-dir outside the worktree — can't map it into the primary checkout.
  if (rel.startsWith("..") || path.isAbsolute(rel)) return "";
  const primaryFindingsDir = path.join(primaryRoot, rel);
  let stray;
  try {
    stray = (await readdir(primaryFindingsDir)).filter((n) => n.endsWith(".json"));
  } catch {
    return "";
  }
  if (stray.length === 0) return "";
  return ` — MISPLACED FINDINGS: ${stray.length} findings artifact(s) were found in the PRIMARY checkout at ${primaryFindingsDir} (${stray.sort().join(", ")}), not in this worktree's --findings-dir. A reviewer wrote findings to the primary checkout's tmp/ instead of this worktree's (${path.resolve(resolvedRepoRoot, findingsDir)}). Reviewer briefings pin the worktree-absolute findings dir; re-dispatch the reviewer(s) or move these artifacts into the worktree --findings-dir.`;
}

export async function consolidateGateFanin(options) {
  // Re-normalize/validate headSha here, not only in the CLI parser: a direct
  // programmatic caller bypasses parseConsolidateFaninCliArgs, and an
  // un-normalized (uppercase/padded) value would spuriously mismatch a
  // correctly-stamped artifact.
  if (options.headSha !== undefined) {
    const headSha = normalizeHeadShaValue(options.headSha);
    if (headSha === null) {
      throw new Error(`--head-sha must be a 7-64 char hex SHA string, got ${JSON.stringify(options.headSha)}`);
    }
    options = { ...options, headSha };
  }
  // --emit-plan key guard (GATE-EXEC-FANOUT-DISPATCH-EMIT): placed after the
  // headSha re-normalization (so the plan's stamp is compared against the
  // normalized round head) and BEFORE the --findings-dir read, so a rejected
  // round writes no --out/--ledger-out and fails fastest. The pair requirement
  // (gate + headSha) lives ONLY here, inside the guard — the CLI parser no
  // longer duplicates it (a parser-level check would exit before this
  // cleanup could clear stale --out/--ledger-out files, Copilot review
  // round 4), so both entry paths fail closed AND clear stale outputs
  // identically.
  // A rejected round must also leave no DURABLE output: any pre-existing files
  // at --out/--ledger-out are from an earlier round at these paths and would
  // otherwise survive as this round's stale result, so the guard clears both
  // (rm force, ENOENT-tolerant) BEFORE re-throwing the verification error —
  // done here, inside consolidateGateFanin's guard, so a programmatic caller
  // fails identically to the CLI. The clear itself is best-effort-bounded: a
  // clear failure is reported alongside the verification error and does not
  // mask it.
  if (options.emitPlan !== undefined) {
    try {
      await verifyEmitPlanKey(options.emitPlan, { gate: options.gate, headSha: options.headSha });
    } catch (err) {
      const clearErrors = [];
      for (const outPath of [options.out, options.ledgerOut]) {
        if (outPath === undefined) continue;
        try {
          await rm(outPath, { force: true });
        } catch (clearErr) {
          clearErrors.push(`could not clear ${JSON.stringify(outPath)}: ${clearErr instanceof Error ? clearErr.message : String(clearErr)}`);
        }
      }
      if (clearErrors.length > 0) {
        // Wrap instead of mutating the caught value: a new Error keeps the
        // original as `cause` (preserving its stack; also safe if a non-Error
        // was thrown) while appending the clear-failure details — the
        // verification error text stays the leading message.
        const cause = err instanceof Error ? err : new Error(String(err));
        throw new Error(`${cause.message} — additionally, the stale-output clear on this fail-closed path failed: ${clearErrors.join("; ")}`, { cause: err });
      }
      throw err;
    }
  }
  // Round-gate normalization (Copilot review round 5): a direct programmatic
  // caller bypasses parseConsolidateFaninCliArgs (whose --gate parsing admits
  // only canonical gates), and verifyEmitPlanKey normalizes the round gate only
  // for its own key compare — so a gate: "REVIEW" (or padded " review ") passed
  // the emit-plan guard yet every downstream `options.gate === "review"`
  // comparison misclassified the round as preApproval (losing review's
  // mandatoryAngles = [] contract). Normalize options.gate (trim + lowercase)
  // BEFORE any downstream use; reject a non-canonical gate with the same
  // no-coercion VALID_GATES membership check the guard applies, so a
  // programmatic gate: null/123/"bogus" fails closed here too (emit-plan
  // callers still get the guard's own "--emit-plan requires ..." wording —
  // the guard runs first and owns that rejection). Placed AFTER the guard so
  // the guard's pair/canonical checks and stale-output cleanup stay the first
  // fail-closed seam; every downstream consumer (cache-telemetry compare,
  // gate config resolution, the result's gate echo) sees the normalized value.
  if (options.gate !== undefined) {
    if (typeof options.gate !== "string" || !VALID_GATES.has(options.gate.trim().toLowerCase())) {
      throw new Error(`--gate must be a canonical supported gate (one of: ${[...VALID_GATES].join(", ")}) to consolidate this round, got ${JSON.stringify(options.gate)}`);
    }
    options = { ...options, gate: options.gate.trim().toLowerCase() };
  }
  const dir = options.findingsDir;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`--findings-dir "${dir}" could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  // A per-angle artifact symlinked into --findings-dir must resolve like a
  // regular file, not vanish silently: readdir reports a symlink as
  // isSymbolicLink(), never isFile(), so a bare isFile() filter would drop it
  // with no warning. stat() (which follows symlinks) each *.json dirent
  // instead; fail closed, naming the entry, on anything that isn't a regular
  // file or a symlink resolving to one.
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
  // only when --carried-angles also has nothing to fill it with, so this
  // guard still catches the real mistake (an empty dir with no carry plan)
  // without blocking the feature's own maximum-saving case.
  if (files.length === 0 && (options.carriedAngles?.length ?? 0) === 0) {
    const misplaced = await detectMisplacedFindingsDiagnostic(dir, options.repoRoot ?? process.cwd());
    throw new Error(`--findings-dir "${dir}" contains no *.json findings artifacts${misplaced}`);
  }

  // Head-stamp exemption membership: exact declared carried names, normalized
  // trim+lowercase only. Deliberately NOT baseAngleName-collapsed — a
  // -delta-at-<sha> sibling is an independently reviewed row, and collapsing
  // would exempt a fresh sibling's stale artifact because its base was
  // carried (fail-open). The carried-upsert path's base-name matching answers
  // a different question (does a real artifact cover the carried slot).
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
    // already-fixed findings or vouch clean for code its reviewer never saw.
    // A declared carried-forward angle is exempt (the ledger's carriedFromHead
    // stays the single provenance field), and so is a "blocked" artifact (the
    // blocked-verdict fail-closed path below owns that failure). A missing or
    // malformed stamp on any other artifact is unknown provenance and fails
    // closed the same way as a mismatch.
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
  // duplicate that angle's findings into every matching section while the
  // flat findings/ledger shape counts them once, silently inflating counts.
  // Fail closed instead, naming every offending angle and its source files.
  const duplicateAngles = [...angleSourceFiles.entries()].filter(([, paths]) => paths.length > 1);
  if (duplicateAngles.length > 0) {
    const detail = duplicateAngles
      .map(([angle, paths]) => `"${angle}" declared in ${paths.join(", ")}`)
      .join("; ");
    throw new Error(`--findings-dir "${dir}" has duplicate angle name(s) across multiple artifact files (ambiguous fan-out): ${detail}`);
  }

  // GATE-EXEC-BRIEFING-PREFIX: the fan-in runs verify-briefing-prefixes.mjs
  // before consolidation so a reviewer seeded with a divergent briefing
  // cannot consolidate into a clean verdict unnoticed. The verifier reads
  // reviewer sentinels for this head and fails closed on: two or more
  // sentinels recording distinct prefix hashes (a seeded-briefing
  // divergence); any sentinel recording no prefix hash (never grandfathered);
  // and, when the conductor declares --expected-dispatch-units, a sentinel
  // count short of the fresh dispatch units it spawned. Grouped fan-out
  // writes one sentinel per GROUP reviewer, so the expected count is the
  // dispatch-UNIT count (groups for grouped dispatch; angle count for
  // per-angle dispatch), never the per-angle artifact count.
  // A head with no sentinels at all still consolidates unless the round's
  // persisted request-plan artifact (the records-floor below) proves units
  // were dispatched, in which case zero sentinels fails closed.
  // Only runs when --head-sha is given.
  if (options.headSha !== undefined) {
    const tmpRoot = options.tmpRoot ?? path.join(process.cwd(), "tmp");
    // Records-floor authority: derive the pending-angle floor from the
    // persisted request-plan artifact(s) for this head, not from a
    // caller-passed flag. --expected-dispatch-units (when also given) still
    // reconciles the exact count; the plan derives whether units were
    // expected at all.
    const requestPlans = await readGateRequestPlansForHead(tmpRoot, options.headSha);
    const requestPlanPendingAngles = deriveRequestPlanPendingAngleCount(requestPlans);
    const prefixVerdict = await verifyBriefingPrefixesForHead(tmpRoot, options.headSha, requestPlanPendingAngles);
    // A round whose request plan expected dispatch units but recorded zero
    // reviewer sentinels fails closed — the vacuous pass the pending-angle
    // floor exists to prevent.
    if (requestPlanPendingAngles > 0 && prefixVerdict.reviewerCount === 0) {
      throw new Error(`GATE-EXEC-BRIEFING-PREFIX records-floor (#1868): the persisted request-plan artifact(s) for head ${options.headSha} (${requestPlans.map((p) => p.filePath).join(", ")}) pends ${requestPlanPendingAngles} pending angle(s), but the round recorded ZERO reviewer sentinels — a coordinator round whose plan recorded pending angles cannot pass vacuously. Re-run the fan-out with evidence capture (verify-fresh-review-context.mjs / record-dispatch-prompt-layout.mjs), then re-consolidate.`);
    }
    if (prefixVerdict.reviewerCount > 0 && !prefixVerdict.verified) {
      throw new Error(`GATE-EXEC-BRIEFING-PREFIX verification failed for head ${options.headSha} (${prefixVerdict.reviewerCount} reviewer sentinel(s)): ${prefixVerdict.reason} — the fan-in refuses to consolidate a round whose invariant-briefing-prefix proof is broken. Re-run the offending reviewer(s), then re-consolidate.`);
    }
    if (options.expectedDispatchUnits !== undefined && prefixVerdict.reviewerCount > 0
        && prefixVerdict.reviewerCount < options.expectedDispatchUnits) {
      throw new Error(`GATE-EXEC-BRIEFING-PREFIX sentinel count (${prefixVerdict.reviewerCount}) is short of the expected dispatch-unit count (${options.expectedDispatchUnits}) for head ${options.headSha} — ${options.expectedDispatchUnits - prefixVerdict.reviewerCount} dispatched reviewer(s) never ran the fresh-context guard (no sentinel written). Re-run the missing reviewer(s), then re-consolidate.`);
    }

    // GATE-EXEC-BRIEFING-PREFIX dispatch-prompt layout: the hash checks above
    // prove the recorded prefix is byte-identical across reviewers, but prove
    // nothing about whether any reviewer's actual prompt was the sanctioned
    // emitted unit. This reads the dispatch records record-dispatch-prompt-layout.mjs
    // writes at fan-out and fails closed when a present record does not BIND to
    // the sanctioned emitter's emitted unit (missing promptContentHash, no
    // canonical emitted file on disk, a hash mismatch from an altered suffix /
    // mismatched delivered prompt, or an emitted unit that is not inline-aligned).
    // A round with no dispatch-prompt records at all is never newly blocked —
    // progressive/optional capture, same posture as GATE-EXEC-PRIMER-EVIDENCE below.
    const layoutVerdict = await verifyDispatchPromptLayoutForHead(tmpRoot, options.headSha);
    if (layoutVerdict.recordCount > 0 && !layoutVerdict.verified) {
      throw new Error(`GATE-EXEC-FANOUT-DISPATCH-EMIT dispatch-prompt layout verification failed for head ${options.headSha} (${layoutVerdict.recordCount} dispatch-prompt record(s)): ${layoutVerdict.reason} — the fan-in refuses to consolidate a round whose reviewer prompt did not bind to the sanctioned emitter's emitted unit. Re-run the sanctioned emitter (emit-fanout-dispatch.mjs) for the offending unit(s), re-dispatch from the emitted promptPath bytes, then re-consolidate.`);
    }
  }

  // GATE-EXEC-PRIMER-EVIDENCE: enforces primer-dispatch ordering evidence as a
  // fail-closed input to consolidation. The primer-evidence artifact
  // (`<gate>-<headSha>.primer-evidence.json`) and the dispatch plan it was
  // derived from are passed in together (parse-time both-or-neither); when
  // present the fan-in re-validates them via enforcePrimerEvidence and fails
  // closed when the ordering barrier, request-group coverage, model-group
  // binding, request-prefix fingerprint, shared-prefix hash, or plan hash is
  // missing or mismatched. Absent both flags the fan-in proceeds unchanged:
  // recording evidence is progressive/optional, so older rounds that never
  // recorded it are not newly blocked.
  if (options.primerEvidence !== undefined && options.primerPlan !== undefined) {
    const readJson = async (filePath, label) => {
      let text;
      try {
        text = await readFile(filePath, "utf8");
      } catch (err) {
        throw new Error(`--primer-${label} "${filePath}" could not be read: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`--primer-${label} "${filePath}" is not valid JSON`);
      }
    };
    const evidence = await readJson(options.primerEvidence, "evidence");
    const plan = await readJson(options.primerPlan, "plan");
    try {
      enforcePrimerEvidence({ plan, evidence });
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  }

  // GATE-EXEC-CACHE-TELEMETRY: enforces the before/after cache-telemetry
  // evidence as a fail-closed input to consolidation. The cache-telemetry
  // artifact (`<gate>-<headSha>.cache-telemetry.json`) is passed as a single
  // JSON path; when present the fan-in re-validates it via
  // enforceCacheTelemetryEvidence and fails closed when the artifact is
  // missing, when verified provider reuse is claimed for an
  // opaque/unavailable-telemetry harness, when a verified result lacks a
  // measured create-then-read sequence, when the aggregate/token report
  // contradicts the recorded events, or when the capability record is
  // missing. Absent the flag the fan-in proceeds unchanged: recording
  // telemetry is progressive/optional, so older rounds that never recorded it
  // are not newly blocked.
  if (options.cacheTelemetry !== undefined) {
    let text;
    try {
      text = await readFile(options.cacheTelemetry, "utf8");
    } catch (err) {
      throw new Error(`--cache-telemetry "${options.cacheTelemetry}" could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    let evidence;
    try {
      evidence = JSON.parse(text);
    } catch {
      throw new Error(`--cache-telemetry "${options.cacheTelemetry}" is not valid JSON`);
    }
    // Bind the artifact to this round's --head-sha/--gate when provided: a
    // cache-telemetry artifact is <gate>-<headSha>-scoped evidence, so a
    // stale or mismatched artifact for a different head or gate must fail
    // closed rather than pass as this round's telemetry.
    if (
      options.headSha !== undefined &&
      String(evidence?.headSha ?? "").trim().toLowerCase() !== options.headSha
    ) {
      throw new Error(`--cache-telemetry "${options.cacheTelemetry}" is stamped for head ${JSON.stringify(
        evidence?.headSha,
      )} but this round consolidates head ${options.headSha} — a stale/mismatched cache-telemetry artifact must not be accepted for a different head`);
    }
    if (options.gate !== undefined && String(evidence?.gate ?? "").trim() !== options.gate) {
      throw new Error(`--cache-telemetry "${options.cacheTelemetry}" is stamped for gate ${JSON.stringify(
        evidence?.gate,
      )} but this round consolidates gate ${options.gate} — a mismatched cache-telemetry artifact must not be accepted`);
    }
    try {
      enforceCacheTelemetryEvidence({ evidence });
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  }

  if (options.prChecklist !== undefined) {
    const hasPrChecklist = rawArtifacts.some(
      (a) => typeof a.angle === "string" && a.angle.trim() === FANIN_SYNTHETIC_ANGLES[0],
    );
    if (!hasPrChecklist) {
      rawArtifacts.push(resolvePrChecklistUpsert(options.prChecklist));
    }
  }

  // Load this worktree's config to resolve the gate's configured blocking
  // severities when --gate is supplied, so the overall verdict honors e.g. a
  // repo that also blocks clean on medium. Without --gate, keep
  // consolidateFanin's own ["high"] default (no config side effects).
  // --repo-root anchors this explicitly so the overall verdict is
  // deterministic regardless of the CLI's invocation directory. Loaded here
  // (before the --carried-angles block below) because that block also needs
  // this same config's mandatory-angle contract.
  let blockCleanOnFindingSeverities;
  let mandatoryAngles; // raw configured mandatory-angle names (resolveGateAngleContract) — only set when --gate is given; fed to angleReviewSurface's alwaysRerun below
  if (options.gate !== undefined) {
    const repoRoot = options.repoRoot ?? process.cwd();
    // A nonexistent/non-directory root would make loadDevLoopConfig silently
    // fall back to shipped defaults — the exact fail-open --repo-root exists
    // to remove. Fail closed instead.
    const rootStat = await stat(repoRoot).catch(() => null);
    if (!rootStat?.isDirectory()) {
      throw new Error(`--repo-root ${JSON.stringify(repoRoot)} is not an existing directory`);
    }
    const { config, errors } = await loadDevLoopConfig({ repoRoot });
    // loadDevLoopConfig never throws: on a parse/validation failure it still
    // returns `config` merged from the shipped defaults, silently replacing
    // this worktree's real gates.<gate>.blockCleanOnFindingSeverities with
    // ["high"]. Since --gate was given specifically to honor that config, a
    // failed load must fail closed here.
    if (Array.isArray(errors) && errors.length > 0) {
      throw new Error(`--gate ${options.gate} was given but this worktree's config (--repo-root ${JSON.stringify(repoRoot)}) could not be fully loaded/validated: ${JSON.stringify(errors)}`);
    }
    // "review" has no config section of its own; its computed verdict reuses
    // pre_approval_gate's configured blocking severities (the stricter gate's
    // bar) purely to decide "clean" vs "findings_present" truthfully — review
    // carries no gate obligations and no mandatory-angle enforcement of its
    // own.
    const gateKey = options.gate === "draft_gate" ? "draft" : "preApproval";
    blockCleanOnFindingSeverities = resolveGateConfig(config, gateKey).blockCleanOnFindingSeverities;
    if (options.gate === "review") {
      mandatoryAngles = [];
    } else {
      // Lowercased to match the base+lowercase key compared against
      // alwaysRerun below — a mandatory angle configured with case drift
      // (e.g. "Correctness") must be refused exactly like its lowercase form.
      mandatoryAngles = resolveGateAngleContract(config, gateKey).mandatoryAngles.map((name) => String(name).trim().toLowerCase());
    }
  }

  // A carried angle (Phase 1.2's plan.carried) got no Phase 2 artifact —
  // upsert its clean entry the same way --pr-checklist does, so it is not
  // invisible to findingsJson/checkFanoutAngleCoverage/the posted verdict
  // comment. A real artifact for that angle always wins (this only fills a
  // gap, never overrides). Matched by baseAngleName + lowercase — same
  // normalization resolve-angle-carry-forward.mjs's own attribution uses —
  // so a real artifact named `<angle>-delta-at-...` or spelled with
  // different case still suppresses the synthetic upsert.
  //
  // --carried-angles is NOT trusted bare. Every name is checked against two
  // independent sources of truth (a programmatic caller that bypasses the
  // parser is re-checked here so this function stays fail-closed on its own):
  //   1. angleReviewSurface(...).kind !== "kinds" — the same predicate
  //      resolve-angle-carry-forward.mjs's own producer uses to decide
  //      plan.carried membership, fed --gate's configured mandatoryAngles as
  //      alwaysRerun. This refuses a configured mandatory angle, a hardcoded
  //      ALWAYS_INCLUDE angle (gate-evidence/renderer-security/pr-description),
  //      and an unmapped/unknown angle in one seam, so this check and the
  //      producer's own rule can never drift apart.
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
    // Re-validate entry shape here too, not just presence of the array — a
    // programmatic caller of consolidateGateFanin bypasses
    // parseConsolidateFaninCliArgs entirely, so a malformed plan entry must
    // still fail closed with this module's own message (or, for a missing
    // carriedFromHead, avoid silently minting an unmarked "clean" row).
    validateCarryForwardPlanEntries(planCarried);
    // Keyed on the exact trimmed angle name, not base+lowercase: the presence
    // proof means "the plan carried THIS name". A base-collapsed key would let
    // a carried sibling (coverage vs coverage-delta-at-<sha>) vouch for a name
    // the plan never carried.
    const planByName = new Map();
    for (const entry of planCarried) {
      const name = entry.angle.trim();
      if (!planByName.has(name)) planByName.set(name, entry);
    }
    // Suppression is checked against real artifacts only (a fixed snapshot
    // taken before this loop runs), never against a sibling --carried-angles
    // entry: two distinct carried names sharing a base+lowercase key (e.g.
    // "coverage" and its legitimate "coverage-delta-at-<sha>" sibling) are
    // both independently carry-forward-eligible and must both upsert,
    // regardless of --carried-angles array order. Carried-vs-carried dedup
    // instead uses the exact trimmed angle name, so only a literal repeated
    // name in --carried-angles collapses.
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
      // A carried angle is not unconditionally upserted clean — when the plan
      // proves it was carrying an open findings_present verdict
      // (validateCarryForwardPlanEntries above already required a non-empty,
      // well-formed "findings" array for that case), upsert the real prior
      // verdict and findings, so the angle stays findings_present here too
      // and consolidateFanin's own blocking computation still blocks on those
      // findings exactly as if freshly reviewed. Absent prevVerdict entirely
      // (an older plan shape), default to clean with no findings.
      const carriedVerdict = planEntry.prevVerdict === "findings_present" ? "findings_present" : "clean";
      const carriedFindings = carriedVerdict === "findings_present" ? planEntry.findings : [];
      rawArtifacts.push({ angle: trimmedAngle, verdict: carriedVerdict, findings: carriedFindings, carriedFromHead: planEntry.carriedFromHead });
    }
  }

  const angles = rawArtifacts.map((a) => ({
    angle: a.angle.trim(),
    verdict: a.verdict.trim(),
    findingCount: Array.isArray(a.findings) ? a.findings.length : 0,
    ...(typeof a.carriedFromHead === "string" ? { carriedFromHead: a.carriedFromHead } : {}),
  }));

  const consolidated = consolidateFanin({ angleResults: rawArtifacts, blockCleanOnFindingSeverities });
  // Neutralize + bound each finding's free-text fields before they reach
  // either output shape. This is the ONE canonical pipeline seam: both the
  // flat ledger (toFindingsLogShape below) and the nested findingsJson (--out)
  // source their finding text from `consolidated.findings`, so a bare
  // `#`-prefixed reference a reviewer put in its summary/recommendation is
  // neutralized (leading `#` stripped) here, once, on raw text before any
  // render/sanitize.
  // Without it, upsert-checkpoint-verdict.mjs's comment-id guard fail-closes
  // on the reviewer's own incidental issue reference and refuses to post the
  // verdict. Deliberate cross-references are unaffected: they live on the
  // verdict body's structured fields, not reviewer finding prose. Neutralize
  // before truncate so a `#` at a truncation boundary can never survive.
  for (const f of consolidated.findings) {
    f.summary = truncateFindingText(neutralizeBareIssuePrIds(f.summary));
    if (f.recommendation) f.recommendation = truncateFindingText(neutralizeBareIssuePrIds(f.recommendation));
    if (f.file) f.file = truncateFindingText(f.file, MAX_FINDING_FILE_LENGTH);
  }
  // toFindingsLogShape's output ({ severity, angle, summary, disposition?, files? })
  // is exactly both write-gate-findings-log.mjs's --findings shape and the flat
  // per-finding shape upsert-checkpoint-verdict.mjs's --findings-json accepts —
  // the same array satisfies both consumer contracts.
  const findings = toFindingsLogShape(consolidated.findings);
  // The nested per-angle shape upsert-checkpoint-verdict.mjs's --findings-json
  // natively accepts: one section per source artifact, including clean
  // angles with an empty findings array, so an all-clean fan-out and
  // mandatory-angle coverage both validate.
  const findingsByAngle = new Map();
  for (const f of consolidated.findings) {
    if (!findingsByAngle.has(f.angle)) findingsByAngle.set(f.angle, []);
    findingsByAngle.get(f.angle).push(f);
  }
  // Fail closed on a blocked consolidation before deriving the nested shape:
  // consolidateFanin() returns blocked with an empty findings array whenever
  // any artifact is malformed or itself blocked, so deriving per-angle
  // verdicts from that array would emit an all-clean findingsJson —
  // silently discarding real findings. A blocked fan-in has no publishable
  // consolidated shape; the caller must fix/re-run the offending reviewer.
  if (consolidated.verdict === "blocked") {
    const detail = Array.isArray(consolidated.malformed) && consolidated.malformed.length > 0
      ? consolidated.malformed
          .map(({ index, reason }) => {
            const artifact = rawArtifacts[index];
            const angle = artifact?.angle ?? `artifact[${index}]`;
            // A "blocked" verdict is a legal artifact shape (a reviewer's
            // documented signal that its review is contaminated/incomplete),
            // not a schema violation. gate-fanin's validateAngleResult only
            // knows the enum clean|findings_present, so it reports this case
            // as "invalid verdict", steering an operator toward "fixing" it by
            // rewriting blocked -> clean instead of re-running the reviewer.
            // Detect it here and say what actually happened.
            if (artifact && typeof artifact === "object" && artifact.verdict === "blocked") {
              return `${angle}: reported verdict "blocked" — re-run that reviewer, then re-consolidate`;
            }
            return `${angle}: ${reason}`;
          })
          .join("; ")
      : "one or more per-angle artifacts report a blocked verdict";
    throw new Error(`fan-in is blocked — refusing to emit a consolidated findings shape (${detail})`);
  }

  // GATE-EXEC-RESOLVED-ANGLE-EVIDENCE: when the caller names the round's full
  // resolved angle set (--resolved-angles) and this round computed a "clean"
  // verdict, every resolved angle must have either a real per-angle artifact
  // or a proven carry. checkFanoutAngleCoverage's own mandatory-angle check
  // protects only a caller-supplied mandatory subset, so a wrong
  // carry-forward declaration naming only non-mandatory angles could
  // otherwise close clean with no mechanical refusal (see the Gate Review
  // Sub-Loop Contract's Phase 3 backstop paragraph,
  // skills/docs/gate-review-sub-loop-contract.md). `rawArtifacts` already
  // includes both real artifacts and any --carried-angles upserts at this
  // point; it only makes a difference for a resolved angle with neither.
  if (options.resolvedAngles !== undefined && consolidated.verdict === "clean") {
    const { missingAngles } = checkResolvedAngleEvidence(options.resolvedAngles, {
      recordedAngles: rawArtifacts,
      carriedAngles: options.carriedAngles ?? [],
    });
    if (missingAngles.length > 0) {
      const misplaced = await detectMisplacedFindingsDiagnostic(options.findingsDir, options.repoRoot ?? process.cwd());
      throw new Error(
        `GATE-EXEC-RESOLVED-ANGLE-EVIDENCE: fan-in computed a "clean" verdict but --resolved-angles names angle(s) with no evidence at all: ${missingAngles.join(", ")} — each expected either a per-angle findings artifact in --findings-dir or a proven carried-forward entry in --carried-angles/--carry-forward-plan; neither was found${misplaced}`,
      );
    }
  }

  // --ledger-out is the durable, always-complete audit trail and must land on
  // disk before any throw-capable step runs against it — not just --out's own
  // I/O, but also the render-budget computation below: fitFindingsToRenderBudget/
  // buildBudgetMarkedFindingsJson call fitsRenderBudget, which deliberately
  // rethrows any non-length-bound error. "findings" is final at this point
  // (the blocked-verdict guard above already ran), so writing here is the
  // latest point that still precedes every remaining throw in this function.
  if (options.ledgerOut !== undefined) {
    await mkdir(path.dirname(options.ledgerOut), { recursive: true });
    // Write `{ overallVerdict, findings }` rather than a bare array so the
    // consolidator's computed verdict flows downstream to the durable ledger
    // (write-gate-findings-log.mjs, via `--findings-file`) without an
    // orchestrator hand-off that could re-type a contradicting `--verdict`.
    // A bare-array consumer (post-gate-findings.mjs) unwraps and ignores it;
    // write-gate-findings-log.mjs threads it into the ledger.
    // ADR 0061 AC1: optional --spec-authority stamps the pinned revision
    // identity onto this ledger via the ONE shared helper. Pure no-op
    // (byte-identical ledger) when the flag is absent. Resolved against
    // --repo-root — the same root this function already anchors its config
    // load / misplaced-findings diagnostic to, so --spec-authority path
    // resolution matches every other writer rather than reading cwd-relative.
    const specAuthorityIdentity = await readSpecAuthorityIdentity(
      options.specAuthority !== undefined ? path.resolve(options.repoRoot ?? process.cwd(), options.specAuthority) : undefined,
      parseError,
    );
    const ledgerRecord = stampOptionalSpecAuthority({ overallVerdict: consolidated.verdict, findings }, specAuthorityIdentity);
    await writeFile(options.ledgerOut, `${JSON.stringify(ledgerRecord, null, 2)}\n`, "utf8");
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
      // Marks a --carried-angles upsert (a prior verdict — clean or
      // findings_present with its findings preserved — not a fresh review at
      // this head) so a reader of --out/the emitted result — not just the
      // ledger's provenance.perAngle — can tell carried from fresh.
      // upsert-checkpoint-verdict.mjs's buildAngleSectionFromNested only reads
      // angle/verdict/findings/unparseable, so this extra field never affects the
      // rendered gate comment.
      ...(typeof a.carriedFromHead === "string" ? { carriedFromHead: a.carriedFromHead } : {}),
    };
  });

  const wholeRoundFits = fitFindingsToRenderBudget(findingsJson);
  let commentFindingsJson = findingsJson;
  let withheldOut = false;
  if (!wholeRoundFits) {
    // A degraded round's only durable record is --ledger-out (a withheld
    // round writes no --out file at all). Without --ledger-out nothing
    // durable lands on disk — the full findings exist only on this process's
    // stdout, an unrecoverable success-envelope-over-zero-evidence outcome —
    // so fail closed here instead of returning ok:true, naming the round size
    // so the caller knows to re-run with --ledger-out.
    if (options.ledgerOut === undefined) {
      throw new Error(
        `fan-in round (${findingsJson.length} angles) is over the gate-comment render budget and would degrade "findingsJson"/--out, but --ledger-out was not given — re-run with --ledger-out <path> so the round's findings are not lost`,
      );
    }
    ({ commentFindingsJson, withheldOut } = buildBudgetMarkedFindingsJson(findingsJson));
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
    // Echoes every artifact this call actually wrote to disk (never a path
    // that was only requested) so one invocation with --out/--ledger-out
    // tells the caller both what to read and where it landed. "ledgerOut" is
    // safe to include unconditionally: reaching this point already means the
    // earlier --ledger-out write succeeded.
    ...(options.ledgerOut !== undefined ? { ledgerOut: options.ledgerOut } : {}),
  };

  // parseConsolidateFaninCliArgs already rejects an --out/--ledger-out pair
  // that resolves to the identical string, but a programmatic caller can skip
  // that parser entirely, and even a CLI caller can defeat a string
  // comparison with a same-file alias (a case-only difference on a
  // case-insensitive filesystem, or a symlink/hardlink). Re-check by file
  // identity here, right before the destructive --out rm/writeFile, so every
  // caller of this shared function is protected. Both paths must already
  // exist (the ledger write above already created --ledger-out) for dev+ino
  // to be comparable; a nonexistent --out is never the same file.
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
      // "commentBudgetExceeded") would otherwise post a prior round's
      // findings as though they were this round's.
      await rm(options.out, { force: true });
    } else {
      await mkdir(path.dirname(options.out), { recursive: true });
      await writeFile(options.out, `${JSON.stringify(commentFindingsJson, null, 2)}\n`, "utf8");
      // Echoed only when a file actually landed at this path — the withheld
      // case above deletes rather than writes it.
      result.out = options.out;
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
