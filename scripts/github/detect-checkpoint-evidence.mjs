#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  buildParseError,
  formatCliError,
  isDirectCliRun,
  normalizeVerdictSurface,
  parseReviewThreads,
  summarizeGateReviewCommentMarkers,
  summarizeGateReviewComments,
} from "../_core-helpers.mjs";
// Historical machine-authored gate artifacts (a standalone findings review, a
// deferred-summary comment) are excluded from evidence at the
// true merge point — inside summarizeGateReviewComments/
// summarizeGateReviewCommentMarkers in packages/core/src/github/
// copilot-helpers.mjs, re-exported here — so every caller of those two
// summarizers (this file, pre-pr-ready-gate.mjs, ready-for-review.mjs,
// request-copilot-review.mjs) is covered by construction rather than needing
// its own per-caller filter.
import { access, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { parsePrNumber, requireTokenValue, runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { fetchGithubReviewThreadsPayload } from "./capture-review-threads.mjs";
import { countUnresolvedGateAuthoredThreadsFromRawNodes } from "./_gate-finding-surface.mjs";
import { isGhBinaryMissing, restFetchPrView, restGetPaginatedJson } from "./_gh-rest-fallback.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { ghJson } from "@dev-loops/core/github/gh";
import { FANOUT_PROVENANCE_MIN_REVIEWERS, GATE_FULL_LABEL, isSizeOutcomeT1Clean, loadDevLoopConfig, resolveFanoutGroups, resolveGateAngleContract, resolveGateConfig, resolveLightMode, resolveRejectForeignAngles, resolveRequireFanoutEvidence, resolveRequireFanoutProvenance, touchesRiskPath } from "@dev-loops/core/config";
import { FANOUT_UNAVAILABLE_MESSAGE, GATE_CONFIG_KEY, checkFanoutAngleCoverage, countFreshDispatchUnits, fanoutReviewerPairingError, freshAngleNames, provenanceConsistencyError } from "@dev-loops/core/loop/gate-fanin";
import { detectMergeBaseChangedFiles, detectMergeBaseScope, isEligibleForLightMode } from "../loop/detect-change-scope.mjs";
import { evaluatePrSizeBudget } from "../loop/check-size-budget.mjs";
import { buildLogPath } from "./write-gate-findings-log.mjs";
import { normalizePrReviewsPayload, prReviewsApiArgs, prReviewsApiPath } from "./_gate-finding-surface.mjs";
import { flattenPaginatedSlurp, resolveAuthenticatedLogin } from "./post-gate-findings.mjs";
import { ensureAsyncRunnerOwnership } from "../loop/_pr-runner-coordination.mjs";
import { detectStaleRunner } from "../loop/_stale-runner-detection.mjs";
import { resolveLedgerCheckouts, resolveRepoRoot } from "../loop/_repo-root-resolver.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { verifyFreshHumanApproval } from "@dev-loops/core/loop/merge-approval";
import { countUnresolvedHumanChangesRequested, resolveSizeBudgetHumanApprovalRequired } from "@dev-loops/core/loop/size-budget-merge-gate";
import { SUBMITTED_REVIEW_STATES } from "@dev-loops/core/github/copilot-helpers";
const USAGE = `Usage: detect-checkpoint-evidence.mjs --repo <owner/name> --pr <number>
Fetch the live PR head SHA and visible PR issue comments, then summarize the
latest valid draft-gate and pre-approval checkpoint verdict comments. Always fail
closed (exit 1) unless both required gate comments exist: a clean draft_gate
comment for the one-time draft boundary and a clean current-head
pre_approval_gate comment.
Required:
  --repo <owner/name>   Repository slug (e.g. owner/repo)
  --pr <number>         Pull request number
Optional:
  --skip-fanout-ledger-check  Skip the fan-out findings-log ledger/provenance/
                              angle-coverage layer of requireFanoutEvidence
                              enforcement. That evidence lives in a gitignored,
                              worktree-local tmp/ file only the machine that ran
                              the review has on disk, so a stateless remote
                              verifier (the gate-evidence CI check; a gh-less API
                              session) can never see it. The comment-derived
                              executionMode/inlineReason check (including the
                              light-mode inline exception) still applies. Intended
                              for server-side/CI callers only; client-side callers
                              should omit this flag to keep full enforcement.
Output (stdout, JSON; always includes preMergeGateCheck):
  {
    "ok": true,
    "repo": "owner/repo",
    "pr": 17,
    "currentHeadSha": "abc1234",
    "draftGate": {
      "visible": true,
      "surface": "review",
      "headSha": "abc1234",
      "verdict": "clean",
      "findingsSummary": "no issues found",
      "nextAction": "mark ready for review",
      "commentId": 101,
      "commentUrl": "https://github.com/owner/repo/pull/17#pullrequestreview-101",
      "updatedAt": "2026-05-29T22:00:00Z"
    },
    "draftGateMarker": {
      "visible": true,
      "surface": "review",
      "headSha": "abc1234",
      "verdict": "clean",
      "findingsSummary": "no issues found",
      "nextAction": "mark ready for review",
      "contractComplete": true,
      "commentId": 101,
      "commentUrl": "https://github.com/owner/repo/pull/17#pullrequestreview-101",
      "updatedAt": "2026-05-29T22:00:00Z"
    },
    "draftGateSatisfied": true,
    "preApprovalGate": {
      "visible": true,
      "surface": "review",
      "headSha": "abc1234",
      "verdict": "clean",
      "findingsSummary": "no issues found",
      "nextAction": "await final human approval",
      "sizeOutcome": "pass",
      "sizeTouchesT1": false,
      "sizeWaiverGranted": false,
      "sizeWaiverApprovedBy": null,
      "commentId": 102,
      "commentUrl": "https://github.com/owner/repo/pull/17#pullrequestreview-102",
      "updatedAt": "2026-05-29T22:00:00Z"
    },
    "preApprovalGateMarker": {
      "visible": true,
      "surface": "review",
      "headSha": "abc1234",
      "verdict": "clean",
      "findingsSummary": "no issues found",
      "nextAction": "await final human approval",
      "contractComplete": true,
      "commentId": 102,
      "commentUrl": "https://github.com/owner/repo/pull/17#pullrequestreview-102",
      "updatedAt": "2026-05-29T22:00:00Z"
    },
    "preMergeGateCheck": {
      "ok": true,
      "failures": []
    },
    "evidenceState": "satisfied"
  }
  (surface is "review"|"issue_comment" (null when not visible): which GitHub
  surface carries that verdict — new rounds always post a PR review,
  "issue_comment" is a legacy verdict comment still read for back-compat.)
  (evidenceState is "satisfied"|"not_established"|"violation": "not_established"
  means evidence for the current head simply doesn't exist yet (draft,
  mid-Copilot-loop, pre-approval not yet re-run after a fix commit); "violation"
  means a visible current-head comment carries a bad verdict, or another
  pre-merge check failed. Present on both success and failure output.)
  (sizeOutcome is "pass"|"escalate"|"block"|null, sizeTouchesT1/sizeWaiverGranted
  are boolean|null, sizeWaiverApprovedBy is string|null: the PR's size-budget
  result (check-size-budget.mjs's computeSizeBudget), round-tripped through the
  verdict comment. null on every field means size evidence is ABSENT — a verdict
  posted before this field set existed, or a gate that never ran the size-budget
  check — which the size-budget merge gate
  (@dev-loops/core/loop/size-budget-merge-gate) reads as "human approval
  required", never as "pass".)
Error output (stderr, JSON):
  { "ok": false, "error": "...", "usage": "..." }
  { "ok": false, "error": "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success (gate evidence is valid)
  1  Argument error, gh failure, malformed gh JSON, or missing required pre-merge gate evidence.
  2  Invalid --jq filter.`.trim();
const parseError = buildParseError(USAGE);
export function parseDetectCheckpointEvidenceCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      "require-before-merge": { type: "boolean" },
      "skip-fanout-ledger-check": { type: "boolean" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
    skipFanoutLedgerCheck: false,
  };
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
    if (token.name === "repo") {
      options.repo = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "pr") {
      options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError);
      continue;
    }
    if (token.name === "skip-fanout-ledger-check") {
      // node:util parseArgs has no `--no-` boolean negation (unlike commander/
      // yargs): `--no-skip-fanout-ledger-check` is rejected as an unknown token
      // below, never silently enabling the skip. So presence => enable, and the
      // only way to keep full enforcement is to omit the flag (the default).
      options.skipFanoutLedgerCheck = true;
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    if (token.name === "require-before-merge") {
      throw parseError(`--require-before-merge has been removed: gate evidence enforcement is now always-on by default. Omit the flag.`);
    }
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined || options.pr === undefined) {
    throw parseError("detect-checkpoint-evidence requires both --repo <owner/name> and --pr <number>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}
// restFallback, when provided, is invoked ONLY when spawning the `gh` binary
// itself fails (ENOENT — the binary is not on PATH); a `gh` invocation that runs
// and fails for any other reason (auth, rate limit, a real 404) is a genuine
// error and is never silently retried through the REST fallback.
async function runGhJson(args, { env, ghCommand, runChild = defaultRunChild, restFallback = null }) {
  try {
    return await ghJson(args, { env, ghCommand, runChild });
  } catch (error) {
    if (restFallback && isGhBinaryMissing(error)) {
      return await restFallback();
    }
    throw error;
  }
}
function normalizeIssueCommentsPayload(payload) {
  if (!Array.isArray(payload)) {
    throw new Error("Invalid gh issue comments payload: expected an array");
  }
  if (payload.every((entry) => Array.isArray(entry))) {
    return payload.flat();
  }
  return payload;
}
function emptyGateSummary() {
  return {
    visible: false,
    surface: null,
    headSha: null,
    verdict: null,
    findingsSummary: null,
    nextAction: null,
    // Size-budget fields (phase 3 of the fail-closed PR size budget): null on every path where no
    // comment/marker is visible OR the visible comment predates this field
    // set — both read identically as "size evidence absent", which the
    // size-budget merge gate (@dev-loops/core/loop/size-budget-merge-gate)
    // fails closed on.
    sizeOutcome: null,
    sizeTouchesT1: null,
    sizeWaiverGranted: null,
    sizeWaiverApprovedBy: null,
    commentId: null,
    commentUrl: null,
    updatedAt: null,
  };
}
function normalizeGateSummary(summary) {
  if (!summary) {
    return emptyGateSummary();
  }
  return {
    visible: true,
    surface: normalizeVerdictSurface(summary.surface),
    headSha: summary.headSha,
    verdict: summary.verdict,
    findingsSummary: summary.findingsSummary,
    nextAction: summary.nextAction,
    sizeOutcome: summary.sizeOutcome ?? null,
    sizeTouchesT1: summary.sizeTouchesT1 ?? null,
    sizeWaiverGranted: summary.sizeWaiverGranted ?? null,
    sizeWaiverApprovedBy: summary.sizeWaiverApprovedBy ?? null,
    commentId: summary.commentId,
    commentUrl: summary.commentUrl,
    updatedAt: summary.updatedAt,
  };
}
function emptyGateMarkerSummary() {
  return {
    visible: false,
    surface: null,
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
    contractComplete: false,
    commentId: null,
    commentUrl: null,
    updatedAt: null,
  };
}
function normalizeGateMarkerSummary(summary) {
  if (!summary) {
    return emptyGateMarkerSummary();
  }
  return {
    visible: true,
    surface: normalizeVerdictSurface(summary.surface),
    headSha: summary.headSha,
    verdict: summary.verdict,
    findingsSummary: summary.findingsSummary,
    nextAction: summary.nextAction,
    executionMode: summary.executionMode ?? null,
    inlineReason: summary.inlineReason ?? null,
    sizeOutcome: summary.sizeOutcome ?? null,
    sizeTouchesT1: summary.sizeTouchesT1 ?? null,
    sizeWaiverGranted: summary.sizeWaiverGranted ?? null,
    sizeWaiverApprovedBy: summary.sizeWaiverApprovedBy ?? null,
    contractComplete: summary.contractComplete === true,
    commentId: summary.commentId,
    commentUrl: summary.commentUrl,
    updatedAt: summary.updatedAt,
  };
}
/**
 * True when at least one non-bot human login present in `reviews`/`comments`
 * has a fresh, head-pinned approval per the sanctioned resolver
 * `verifyFreshHumanApproval` (merge-approval.mjs): a head-pinned APPROVED
 * review OR a head-pinned "approve merge <headSha>" comment authored by that
 * SAME login. `buildPreMergeGateCheck` has no single named approver to check
 * (unlike merge-pr.mjs's `--human-approved-by`), so this tries every distinct
 * human login the two streams surface against the one existing resolver
 * rather than reimplementing its bot-exclusion/head-pinning/marker rules.
 */
function anyFreshHumanApproval({ currentHeadSha, reviews, comments }) {
  const candidateLogins = new Set();
  for (const entry of reviews) {
    if (typeof entry?.login === "string" && entry.login.length > 0) candidateLogins.add(entry.login);
  }
  for (const entry of comments) {
    if (typeof entry?.login === "string" && entry.login.length > 0) candidateLogins.add(entry.login);
  }
  for (const login of candidateLogins) {
    if (verifyFreshHumanApproval({ approvedBy: login, currentHeadSha, reviews, comments }).satisfied) return true;
  }
  return false;
}

/**
 * Decide whether a gate's execution mode satisfies fan-out evidence
 * enforcement (fanout_fanin, or a light-mode-accepted inline verdict),
 * independent of the ledger/provenance/angle-coverage layer below it. Returns
 * null when it qualifies, else an error message.
 *
 * The ONE place mode qualification is decided: buildPreMergeGateCheck
 * (merge-time) and upsert-checkpoint-verdict.mjs (post-time) both call this
 * against the same `gate` descriptor so the two can never drift apart.
 */
export function evaluateInlineFanoutMode(gate, fanoutEnforcement) {
  // Light-mode acceptance: fail CLOSED unless every condition below
  // holds. Any non-light inline verdict falls through to the rejection below.
  const lightAccepted =
    gate.executionMode === "inline_single_agent"
    && fanoutEnforcement.lightMode === true
    && fanoutEnforcement.hasFullLabel !== true
    && gate.scopeUnderThreshold === true
    && typeof gate.inlineReason === "string"
    && gate.inlineReason.trim().length > 0;
  if (gate.executionMode !== "fanout_fanin" && !lightAccepted) {
    return `${gate.name}: requireFanoutEvidence is enabled but executionMode is "${gate.executionMode ?? "unset"}" (expected "fanout_fanin"); inline gate verdicts are not accepted`;
  }
  return null;
}
/**
 * Coerce the parsed review-thread unresolved count to the value
 * buildPreMergeGateCheck consumes. A missing/malformed/non-numeric
 * unresolvedThreads is UNKNOWN, not zero: return -1 (the existing
 * "unknown thread state" sentinel that fails CLOSED at merge), never 0.
 * A genuine non-negative integer count passes through unchanged.
 */
export function coerceUnresolvedThreadCount(parsedThreads) {
  const raw = parsedThreads?.summary?.unresolvedThreads;
  return Number.isInteger(raw) && raw >= 0 ? raw : -1;
}
export function buildPreMergeGateCheck(evidence, unresolvedThreadCount = null, staleRunnerCheck = null, fanoutEnforcement = null, { skipFanoutLedgerCheck = false } = {}) {
  const failures = [];
  const warnings = [];
  if (!(evidence.draftGate.visible && evidence.draftGate.verdict === "clean")) {
    failures.push("missing visible clean draft_gate comment");
  }
  const preApproval = evidence.preApprovalGateMarker;
  const preApprovalEstablished =
    preApproval.visible
    && preApproval.contractComplete
    && preApproval.verdict === "clean"
    && preApproval.headSha === evidence.currentHeadSha;
  if (!preApprovalEstablished) {
    failures.push("missing visible clean current-head pre_approval_gate comment");
  }
  // Size-budget merge gate (resolveSizeBudgetHumanApprovalRequired), consulted
  // LIVE on this authoritative pre-merge path — but only once the base
  // pre_approval_gate verdict is itself established: an absent/stale verdict
  // already fails closed above (not_established/violation), so a redundant
  // size failure would add no signal. sizeTouchesT1 is remapped to touchesT1
  // (see size-budget-merge-gate.mjs's own naming note). The human approval
  // signal accepts EITHER a human APPROVED review OR a head-pinned
  // "approve merge <headSha>" operator comment — see anyFreshHumanApproval
  // above — so a solo-owner PR (which GitHub forbids from self-APPROVED) is
  // never unsatisfiable.
  if (preApprovalEstablished) {
    const reviews = Array.isArray(evidence.reviews) ? evidence.reviews : [];
    const comments = Array.isArray(evidence.comments) ? evidence.comments : [];
    // A reviews-read failure (evidence.reviewsReadFailed) must never be
    // consumed here as "zero reviews" — an unreadable stream could hide a
    // real unresolved CHANGES_REQUESTED. Force a non-zero count so the
    // resolver below fails closed (still requires approval) regardless of
    // any comment-marker approval, without touching how a genuine zero
    // reads when reviews WERE read successfully.
    const unresolvedChangesRequestedCount = evidence.reviewsReadFailed === true
      ? Number.POSITIVE_INFINITY
      : countUnresolvedHumanChangesRequested(reviews);
    if (resolveSizeBudgetHumanApprovalRequired({
      sizeOutcome: preApproval.sizeOutcome,
      touchesT1: preApproval.sizeTouchesT1,
      humanApprovalSatisfied: anyFreshHumanApproval({ currentHeadSha: evidence.currentHeadSha, reviews, comments }),
      unresolvedChangesRequestedCount,
    })) {
      failures.push(
        evidence.reviewsReadFailed === true
          ? "size-budget merge gate cannot verify human approval/unresolved CHANGES_REQUESTED state for this escalated/T1 PR: PR reviews could not be read (fail closed)"
          : "size-budget requires a human APPROVED review OR a head-pinned \"approve merge <headSha>\" operator comment, with zero unresolved CHANGES_REQUESTED, for this escalated/T1 PR",
      );
    }
  }
  // Fail-closed fan-out evidence enforcement (gates.requireFanoutEvidence, ON by
  // default / opt-out). When disabled or config-unavailable, fanoutEnforcement is
  // { required: false, gates: [] } so the `.required` guard skips this block.
  if (fanoutEnforcement && fanoutEnforcement.required) {
    for (const gate of fanoutEnforcement.gates) {
      const modeFailure = evaluateInlineFanoutMode(gate, fanoutEnforcement);
      if (modeFailure) {
        failures.push(modeFailure);
        continue;
      }
      // A stateless remote verifier (the gate-evidence CI check, or a gh-less API
      // session) never has the gitignored, machine-local tmp/gate-findings ledger
      // on disk (it lives under the main worktree's tmp/) — only the machine
      // that ran the review does. skipFanoutLedgerCheck
      // scopes enforcement down to what IS remotely verifiable from the PR's public
      // comment history: the comment-derived executionMode/inlineReason check above
      // (including the light-mode inline exception). The deeper ledger/provenance/
      // angle-coverage layer stays client-side-only (skills/docs/gate-review-sub-loop-contract.md's
      // existing "not un-forgeable" caveat covers that gap).
      if (skipFanoutLedgerCheck) {
        continue;
      }
      if (!gate.ledgerExists) {
        failures.push(
          `${gate.name}: requireFanoutEvidence is enabled but no findings-log ledger exists for the reviewed head (${gate.ledgerPath})`,
        );
        continue;
      }
      // Opt-in provenance enforcement (gates.requireFanoutProvenance), layered on
      // top of fan-out evidence. When off (default) requireProvenance is falsy so
      // NO new failure is added — behavior is byte-identical to today. When on, a
      // fanout_fanin ledger must record INTERNALLY-CONSISTENT provenance (checked
      // the same way the write path validates it — a hand-edited or shadow ledger
      // is re-validated here, not trusted) with distinctReviewers >= the floor.
      // Provenance is enforced ONLY for fanout_fanin verdicts: a
      // light-accepted inline verdict is already scope-bounded and has no
      // multi-reviewer provenance to record, so requiring it would make the
      // light path unmergeable — the inverse of this issue's fix.
      if (fanoutEnforcement.requireProvenance && gate.executionMode === "fanout_fanin") {
        const prov = gate.provenance;
        const consistencyErr = provenanceConsistencyError(prov);
        const reviewers = prov && Number.isInteger(prov.distinctReviewers) ? prov.distinctReviewers : null;
        if (consistencyErr) {
          failures.push(
            `${gate.name}: requireFanoutProvenance is enabled but the findings-log ledger lacks valid fan-out provenance (${consistencyErr}); ${FANOUT_UNAVAILABLE_MESSAGE}`,
          );
        } else {
          // The floor scales with the fresh DISPATCH UNITS actually recorded
          // (one reviewer per fresh angle, but one reviewer per declared
          // GROUP of fresh angles), at minimum
          // FANOUT_PROVENANCE_MIN_REVIEWERS — a ledger recording more fresh
          // dispatch units than distinct reviewers could only have paired one
          // reviewer across units.
          const freshUnitCount = countFreshDispatchUnits(prov.perAngle);
          const requiredReviewers = Math.max(FANOUT_PROVENANCE_MIN_REVIEWERS, freshUnitCount);
          // Re-validate the per-identity pairing here too: the ledger is a
          // worktree-local file, so the read path must not trust that the
          // write-time floor produced it (a hand-crafted padded ledger can
          // satisfy the cardinality floor while one reviewer covers two
          // fresh angles/groups). gate.resolvedGroups cross-checks a claimed
          // `group` against this round's actual dispatch-group resolution
          // (mode/gate:full-aware) rather than accepting any self-attested label.
          const pairingErr = fanoutReviewerPairingError(prov.perAngle, gate.resolvedGroups);
          if (reviewers === null || reviewers < requiredReviewers) {
            failures.push(
              `${gate.name}: requireFanoutProvenance is enabled but the findings-log ledger lacks valid fan-out provenance (need provenance.distinctReviewers >= ${requiredReviewers}${requiredReviewers > FANOUT_PROVENANCE_MIN_REVIEWERS ? ` [max(${FANOUT_PROVENANCE_MIN_REVIEWERS}, ${freshUnitCount} fresh dispatch unit(s))]` : ""}, got ${reviewers === null ? "none" : reviewers}); ${FANOUT_UNAVAILABLE_MESSAGE}`,
            );
          } else if (pairingErr !== null) {
            failures.push(
              `${gate.name}: requireFanoutProvenance is enabled but the findings-log ledger lacks valid fan-out provenance (${pairingErr}); ${FANOUT_UNAVAILABLE_MESSAGE}`,
            );
          }
        }
      }
      // Angle-coverage enforcement: independent of requireFanoutProvenance.
      // When the gate configures mandatory angles, a fanout_fanin ledger MUST
      // record internally-consistent provenance — otherwise a shadow ledger
      // that simply omits provenance would bypass mandatory-angle coverage.
      // Recorded provenance is then re-validated: perAngle must cover every
      // mandatory angle and (default) stay within the configured pool. Gates
      // without mandatory angles keep today's behavior (absent provenance adds
      // no failure; that stricter gap is requireFanoutProvenance's opt-in).
      if (gate.executionMode === "fanout_fanin") {
        const mandatoryAngles = gate.mandatoryAngles ?? [];
        const provValid = gate.provenance != null && provenanceConsistencyError(gate.provenance) === null;
        if (mandatoryAngles.length > 0 && !provValid) {
          failures.push(
            `${gate.name}: mandatory angle coverage is configured (${mandatoryAngles.join(", ")}) but the findings-log ledger records no valid fan-out provenance to verify it against; write the ledger with --provenance covering the mandatory angles; ${FANOUT_UNAVAILABLE_MESSAGE}`,
          );
        } else if (provValid) {
          const { missingMandatory, foreignAngles } = checkFanoutAngleCoverage(gate.provenance.perAngle, {
            mandatoryAngles,
            pool: gate.anglePool ?? null,
          });
          if (missingMandatory.length > 0) {
            failures.push(
              `${gate.name}: fan-out provenance is missing mandatory angle(s): ${missingMandatory.join(", ")}; ${FANOUT_UNAVAILABLE_MESSAGE}`,
            );
          }
          if (foreignAngles.length > 0) {
            const message = `${gate.name}: fan-out provenance names angle(s) outside the configured pool: ${foreignAngles.join(", ")}`;
            if (fanoutEnforcement.rejectForeignAngles ?? true) {
              failures.push(`${message}; ${FANOUT_UNAVAILABLE_MESSAGE}`);
            } else {
              // rejectForeignAngles: false is WARNING mode, not silence.
              warnings.push(`${message} (gates.rejectForeignAngles is false; recorded as a warning)`);
            }
          }
        }
      }
    }
  }
  if (typeof unresolvedThreadCount === "number" && unresolvedThreadCount !== 0) {
    if (unresolvedThreadCount === -1) {
      failures.push("could not fetch review thread state from GitHub API; re-run gate evidence check when API connectivity is restored");
    } else {
      failures.push(`unresolved review threads present (${unresolvedThreadCount}); must resolve all threads before merge`);
    }
  }
  if (staleRunnerCheck && !staleRunnerCheck.ok) {
    for (const failure of staleRunnerCheck.failures) {
      failures.push(failure);
    }
  }
  return {
    ok: failures.length === 0,
    failures,
    // Additive: only present when non-empty, preserving the existing {ok, failures} shape.
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
/** Canonical evidenceState values (single source of truth for the gate-evidence status mapping). */
export const EVIDENCE_STATE = Object.freeze({
  SATISFIED: "satisfied",
  NOT_ESTABLISHED: "not_established",
  VIOLATION: "violation",
});

// "absent" (no visible comment yet for this head) vs "bad" (a comment exists for
// this exact head but its verdict/contract is not clean) — the distinction
// evidenceState needs: absent is the normal in-progress gap (not_established),
// bad is an actual problem (violation). Head-mismatch is not a separate case
// here: summarizeGateReviewCommentMarkers already filters markers to the exact
// current head, so a marker for a stale/older head is simply invisible (absent).
function gateVerdictState({ visible, verdict, contractComplete = true }) {
  if (!visible) return "absent";
  if (contractComplete === false) return "bad";
  return verdict === "clean" ? "clean" : "bad";
}

/**
 * Classify WHY the checkpoint-evidence pre-merge check is (un)satisfied, for
 * the gate-evidence commit-status mapping: `not_established` (evidence for
 * the current head doesn't exist yet — draft, mid-Copilot-loop, or right
 * after a fix commit before pre_approval_gate re-runs) reads as `pending`;
 * `violation` (a visible current-head comment carries a bad verdict, or
 * another pre-merge check failed) reads as `failure`; `satisfied` reads as
 * `success`. Both gates clean is a precondition for `satisfied`, not its
 * definition — a clean-gates PR can still fail on an unrelated pre-merge
 * check, which is a real problem (violation), not "waiting".
 */
export function deriveEvidenceState(evidence, preMergeGateCheck) {
  const draftState = gateVerdictState({ visible: evidence.draftGate.visible, verdict: evidence.draftGate.verdict });
  const preApprovalState = gateVerdictState({
    visible: evidence.preApprovalGateMarker.visible,
    verdict: evidence.preApprovalGateMarker.verdict,
    contractComplete: evidence.preApprovalGateMarker.contractComplete,
  });
  if (draftState === "bad" || preApprovalState === "bad") {
    return EVIDENCE_STATE.VIOLATION;
  }
  if (draftState === "absent" || preApprovalState === "absent") {
    return EVIDENCE_STATE.NOT_ESTABLISHED;
  }
  return preMergeGateCheck?.ok === true ? EVIDENCE_STATE.SATISFIED : EVIDENCE_STATE.VIOLATION;
}

async function ledgerExists(fullPath) {
  try {
    await access(fullPath);
    return true;
  } catch {
    return false;
  }
}
/**
 * True if the ledger (relative path) exists under ANY enumerated checkout
 * (main + every worktree). A ledger written in the PR worktree is
 * found even when the check runs from a different checkout's git-toplevel.
 */
async function ledgerExistsInAny(checkouts, ledgerPath) {
  for (const root of checkouts) {
    if (await ledgerExists(path.resolve(root, ledgerPath))) {
      return true;
    }
  }
  return false;
}
/**
 * Read the recorded fan-out `provenance` object from a ledger across the
 * enumerated checkouts. Mirrors ledgerExistsInAny's "ANY checkout satisfies"
 * semantics: prefers the FIRST checkout whose ledger provenance actually
 * SATISFIES the FULL active enforcement — internally consistent, meeting the
 * distinctReviewers floor when requireFanoutProvenance is on, AND passing the
 * gate's angle contract (mandatory-angle coverage; pool membership when
 * foreign angles are rejected) — so a stale checkout's below-floor,
 * provenance-less, or angle-contract-failing ledger cannot SHADOW a valid one
 * in the PR worktree (which would falsely fail closed). Falls back to the
 * first non-null provenance (for a useful diagnostic message) only when NO
 * checkout satisfies, and null only when none is present. Called whenever
 * requireFanoutProvenance is enabled OR the gate's verdict is fanout_fanin —
 * inline verdicts never trigger this read.
 */
async function readLedgerProvenanceInAny(checkouts, ledgerPath, criteria = {}) {
  const {
    requireProvenance = false, mandatoryAngles = [], anglePool = null, rejectForeignAngles = true,
    config = null, gateKey = "draft_gate", hasFullLabel = false,
  } = criteria;
  const satisfies = (prov) => {
    if (provenanceConsistencyError(prov) !== null) return false;
    // The floor and the pairing cross-check both key off this candidate
    // ledger's OWN fresh angles/groups — resolveFanoutGroups per candidate,
    // not once up front, since a stale checkout can record a different fresh
    // angle set than the worktree ledger.
    const resolvedGroups = resolveFanoutGroups(config, GATE_CONFIG_KEY[gateKey] ?? gateKey, freshAngleNames(prov.perAngle), { fullLabel: hasFullLabel });
    if (requireProvenance && prov.distinctReviewers < Math.max(FANOUT_PROVENANCE_MIN_REVIEWERS, countFreshDispatchUnits(prov.perAngle))) return false;
    if (requireProvenance && fanoutReviewerPairingError(prov.perAngle, resolvedGroups) !== null) return false;
    const { missingMandatory, foreignAngles } = checkFanoutAngleCoverage(prov.perAngle, { mandatoryAngles, pool: anglePool });
    if (missingMandatory.length > 0) return false;
    if (foreignAngles.length > 0 && rejectForeignAngles) return false;
    return true;
  };
  let firstNonNull = null;
  for (const root of checkouts) {
    const full = path.resolve(root, ledgerPath);
    try {
      const parsed = JSON.parse(await readFile(full, "utf8"));
      const prov = parsed && typeof parsed === "object" ? parsed.provenance : null;
      if (prov == null) continue; // ledger present but no provenance — keep scanning.
      if (satisfies(prov)) {
        return prov; // satisfying ledger — prefer it over any earlier failing one.
      }
      if (firstNonNull === null) firstNonNull = prov; // remember for diagnostics.
    } catch {
      // Missing/unreadable/malformed ledger in this checkout — try the next.
    }
  }
  return firstNonNull;
}
// A committed `.devloops` is a small hand-authored config file; 8 MiB is
// already many times larger than any legitimate one, so bounding `git show`
// here only guards against a runaway/corrupt blob, never a real config.
const HEAD_DEVLOOPS_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * Read the PR head commit's committed `.devloops` (bare, then `.yaml`/`.yml`/
 * `.json`, matching loadDevLoopConfig's own disk precedence) via `git show`.
 * Git worktrees of the same repo share one object store, so this succeeds
 * from ANY checkout as long as the head commit was fetched into ANY of
 * them — no need to loop over `resolveLedgerCheckouts` the way ledger BYTE
 * reads do (those are gitignored tmp/ files, not git objects).
 * @returns {{ ok: true, raw: string|null, path: string } | { ok: false }}
 *   `ok: false` means either the head COMMIT itself isn't resolvable locally
 *   (never fetched anywhere sharing this .git) OR a `.devloops` that DOES
 *   exist at this ref failed to read for some other reason (oversized blob,
 *   object-store error) — either way the caller must fall back to the
 *   invoking checkout's config, never silently take head DEFAULTS in place of
 *   an override that actually exists. `raw: null` (`ok: true`) means the
 *   commit resolves and every extension was confirmed genuinely ABSENT at
 *   this ref — a legitimate "PR head has no primary override" state, not a
 *   failure.
 */
function readHeadDevloopsSource(repoRoot, headSha) {
  for (const ext of ["", ".yaml", ".yml", ".json"]) {
    const relPath = `.devloops${ext}`;
    const ref = `${headSha}:${relPath}`;
    try {
      // Existence probe FIRST, separate from the content read below, so a
      // read failure on a path that genuinely exists is never confused with
      // the path simply not existing at this extension/ref.
      execFileSync("git", ["cat-file", "-e", ref], { cwd: repoRoot, stdio: ["ignore", "ignore", "ignore"] });
    } catch {
      // Genuinely absent at this extension for this ref — try the next.
      continue;
    }
    try {
      const raw = execFileSync("git", ["show", ref], {
        cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: HEAD_DEVLOOPS_MAX_BUFFER_BYTES,
      });
      return { ok: true, raw, path: relPath };
    } catch {
      // The path exists at this ref but reading it failed (e.g. it exceeds
      // maxBuffer, or another object-store error) — this is NOT absence, so
      // it must fail CLOSED (never fall through to a later extension, and
      // never reach the raw:null/head-defaults branch below), forcing the
      // caller to fall back to invokingConfig instead of silently loosening
      // enforcement to head defaults.
      return { ok: false };
    }
  }
  try {
    execFileSync("git", ["cat-file", "-e", `${headSha}^{commit}`], {
      cwd: repoRoot, stdio: ["ignore", "ignore", "ignore"],
    });
    return { ok: true, raw: null, path: ".devloops" };
  } catch {
    return { ok: false };
  }
}

/**
 * Resolve the config that governs the angle-pool / fanout-groups /
 * mandatory-angle layer: the PR HEAD commit's committed `.devloops`, not the
 * invoking checkout's. A fan-out that ran conformantly under
 * its own (possibly renamed/regrouped) config must validate from ANY
 * checkout, including a pre-merge main that predates the change — the ledger
 * BYTES already read from any checkout (readLedgerProvenanceInAny), but the
 * angle-contract config they're checked against was still the invoking
 * checkout's, producing false out-of-pool/missing-mandatory violations.
 *
 * extensionDefaults and `.pi/dev-loop/defaults` still come from `repoRoot` on
 * disk — only the `.devloops` primary-override layer is re-sourced from the
 * head commit. Falls back to `invokingConfig` (today's behavior, never
 * looser, never a silent enforcement skip) when the head commit isn't
 * resolvable locally or its `.devloops` fails to parse/validate.
 */
async function resolveAngleLayerConfig({ invokingConfig, repoRoot, headSha }) {
  if (typeof headSha !== "string" || headSha.trim().length === 0) {
    return invokingConfig;
  }
  const source = readHeadDevloopsSource(repoRoot, headSha);
  if (!source.ok) {
    return invokingConfig; // head commit unresolvable locally -> fall back.
  }
  const { config: headConfig, errors } = await loadDevLoopConfig({
    repoRoot,
    devloopsOverride: { raw: source.raw, path: source.path },
  });
  // Only fall back on a HEAD-ATTRIBUTABLE error: the `devloops` layer is the
  // head override itself, and `merged` is the final validation, which can
  // fail BECAUSE of the head override's content — both must still trigger
  // the fallback. `extensionDefaults`/`defaults` errors are read from this
  // same repoRoot's disk in both the head-resolved and invoking config, so a
  // broken base layer there cannot be fixed by falling back and must not
  // discard an otherwise-valid head override.
  const headAttributable = (error) => error.layer === "devloops" || error.layer === "merged";
  if (Array.isArray(errors) && errors.some(headAttributable)) {
    return invokingConfig; // head .devloops present but unparseable/invalid -> fall back.
  }
  return headConfig;
}

/**
 * Build the fan-out evidence enforcement descriptor.
 *
 * Enforcement is ON by default (opt-out via gates.requireFanoutEvidence: false).
 * Returns { required: false } when disabled OR config is unavailable
 * (config == null after a failed load) — config-unavailable must fail open
 * and never enable enforcement. When enabled, returns
 * { required: true, requireProvenance, lightMode, hasFullLabel, gates } where
 * each per-required-gate entry records executionMode, inlineReason,
 * scopeUnderThreshold, and whether the deterministic findings-log ledger exists
 * for the reviewed head SHA, so the pre-merge check can fail closed on inline
 * verdicts or missing ledgers.
 *
 * Light mode: when gates.lightMode is configured, `hasFullLabel`
 * (gate:full PR label) and `baseRef` feed a fail-closed merge-base scope
 * re-derivation for inline verdicts. A gate's scopeUnderThreshold is true only
 * when light mode is on, the PR has no gate:full label, a base ref is known,
 * and the reviewed head's merge-base diff is genuinely under threshold — which
 * lets the pre-merge check accept an inline single-agent verdict for a
 * small-scope PR instead of always rejecting inline evidence.
 */
// isSizeOutcomeT1Clean: the ONE shared T1-clean predicate for the
// GATE-EXEC-PROPORTIONALITY size-outcome floor now lives in
// packages/core/src/config/config.mjs (imported above) so this merge gate and
// resolveGateDispatchMode never drift onto two independently-maintained floor
// implementations. Re-exported here for import-path back-compat.
export { isSizeOutcomeT1Clean };

export async function buildFanoutEnforcement({ repo, pr, currentHeadSha, draftGateMarker, preApprovalGateMarker, config, cwd, hasFullLabel = false, baseRef = null }) {
  // Fail open when config could not be loaded/validated. `== null` covers both
  // null and undefined; the loader only ever yields null on failure, but the
  // loose check defensively treats an absent config as unavailable.
  if (config == null || !resolveRequireFanoutEvidence(config)) {
    // Disabled/unavailable return is intentionally byte-identical to before
    // (no requireProvenance key): buildPreMergeGateCheck only reads it inside
    // the `required` block, so this preserves the exact existing shape.
    return { required: false, gates: [] };
  }
  // Provenance enforcement is opt-in and layered ON TOP of fan-out evidence: it
  // only takes effect while evidence enforcement (above) is active.
  const requireProvenance = resolveRequireFanoutProvenance(config);
  // Angle-coverage enforcement (mandatory angles + pool membership) is layered
  // independently of requireProvenance: it re-validates whatever provenance a
  // fanout_fanin ledger actually recorded, regardless of that opt-in flag.
  const rejectForeignAngles = resolveRejectForeignAngles(config);
  // Light-mode facts: the threshold that a re-derived merge-base scope
  // must fall under for an inline verdict to be accepted. null when lightMode is
  // disabled → no inline verdict can ever be accepted (scopeUnderThreshold stays
  // false), preserving today's rejection.
  const lightThreshold = resolveLightMode(config);
  const lightMode = lightThreshold != null;
  const checkouts = resolveLedgerCheckouts(cwd);
  // checkouts[0] is always resolveRepoRoot(cwd) (resolveLedgerCheckouts adds it
  // first, unconditionally, and never throws — it falls back to cwd on git
  // failure) — reuse it instead of a second `git rev-parse --show-toplevel`.
  const repoRoot = checkouts[0];
  // Angle-pool / fanout-groups / mandatory-angle layer authority: the PR
  // HEAD's committed config, not this invoking checkout's — see
  // resolveAngleLayerConfig. ONE resolution, reused for every resolver below
  // (resolveGateConfig, resolveGateAngleContract, resolveFanoutGroups,
  // including the per-candidate resolution inside readLedgerProvenanceInAny)
  // so they can never drift apart on which config governs the angle layer.
  const angleConfig = await resolveAngleLayerConfig({ invokingConfig: config, repoRoot, headSha: currentHeadSha });
  // Gate ACTIVATION (`.required`) stays sourced from the INVOKING checkout's
  // config, never the head-sourced angleConfig: a PR that sets its own
  // `gates.preApproval.required: false` must not be able to remove a gate
  // from fanoutEnforcement.gates (and thereby skip its ledger/provenance/
  // angle checks) when the checkout that is actually enforcing this PR still
  // requires it. Only the angle-CONTRACT resolvers below (resolveGateAngleContract,
  // resolveFanoutGroups) use angleConfig — activation and angle-contract are
  // deliberately split across two different config sources.
  const draftGateConfig = resolveGateConfig(config, "draft");
  const preApprovalGateConfig = resolveGateConfig(config, "preApproval");
  // Shared angle-contract resolver (exclude-filtered mandatory angles +
  // additive-aware pool) — the same contract the write paths enforce. The
  // field names here (`mandatoryAngles`/`anglePool`) are exactly what
  // buildPreMergeGateCheck reads off each gate entry.
  const buildAngleFields = (gateKey) => {
    const { mandatoryAngles, pool } = resolveGateAngleContract(angleConfig, gateKey);
    return { mandatoryAngles, anglePool: pool };
  };
  const GATE_ANGLE_CONFIG = {
    draft_gate: buildAngleFields("draft"),
    pre_approval_gate: buildAngleFields("preApproval"),
  };
  const gateSpecs = [
    { name: "draft_gate", marker: draftGateMarker, required: draftGateConfig.required },
    { name: "pre_approval_gate", marker: preApprovalGateMarker, required: preApprovalGateConfig.required },
  ].filter((spec) => spec.required && spec.marker.visible);
  const gates = [];
  for (const spec of gateSpecs) {
    const headSha = spec.marker.headSha ?? currentHeadSha;
    // Relative on purpose: writeGateFindingsLog anchors the ledger at the MAIN
    // worktree tmp, and the ledgerExistsInAny / readLedgerProvenanceInAny
    // scans below resolve this relative path against EVERY enumerated checkout
    // (resolveLedgerCheckouts, which always includes the main worktree). So the
    // merge — running from the main checkout — finds the centralized ledger via
    // the main-worktree entry, while the multi-checkout scan still defends
    // against a forged per-worktree shadow ledger. Anchoring this read at the
    // main worktree directly would collapse that shadow-defense scan.
    const ledgerPath = buildLogPath({ repo, pr, gate: spec.name, headSha, tmpRoot: "tmp" });
    // Re-derive scope FAIL-CLOSED for inline verdicts only (the fan-out default
    // path pays no git I/O). scopeUnderThreshold is true ONLY when lightMode is
    // on, the PR has no gate:full label, a base ref is known, and the merge-base
    // diff for the reviewed head is genuinely under threshold AND clears BOTH
    // GATE-EXEC-PROPORTIONALITY floors below. Any git/scope/floor failure leaves
    // it false, so the inline verdict is rejected exactly as today. The
    // recorded `inlineReason` marker is audit-only here — every floor is
    // RECOMPUTED from the actual merge-base diff, never trusted from the
    // marker, mirroring requireFanoutProvenance's re-verify-from-evidence
    // pattern: a recorded light-mode decision whose diff was not eligible
    // fails closed regardless of what it claims.
    let scopeUnderThreshold = false;
    if (lightMode && !hasFullLabel && baseRef && spec.marker.executionMode === "inline_single_agent") {
      const scope = detectMergeBaseScope({ base: baseRef, head: headSha, cwd: repoRoot });
      const sizeCapOk = scope.ok === true && isEligibleForLightMode(scope, lightThreshold);
      let riskPathOk = false;
      if (sizeCapOk) {
        const changedFilesResult = detectMergeBaseChangedFiles({ base: baseRef, head: headSha, cwd: repoRoot });
        riskPathOk = changedFilesResult.ok === true && !touchesRiskPath(changedFilesResult.files, lightThreshold.riskPaths);
      }
      let sizeOutcomeOk = false;
      if (riskPathOk) {
        try {
          const sizeOutcome = await evaluatePrSizeBudget({ base: baseRef, head: headSha, repoRoot });
          sizeOutcomeOk = isSizeOutcomeT1Clean(sizeOutcome);
        } catch {
          sizeOutcomeOk = false; // fails CLOSED on a size-budget computation error
        }
      }
      scopeUnderThreshold = sizeCapOk && riskPathOk && sizeOutcomeOk;
    }
    // Read ledger provenance for ANY fanout_fanin gate (not just when
    // requireProvenance is on): angle-coverage enforcement re-validates
    // whatever provenance is recorded independently of that opt-in flag.
    // The selection criteria mirror the full active enforcement so a stale
    // checkout's contract-failing ledger cannot shadow a passing one.
    const readProvenance = requireProvenance || spec.marker.executionMode === "fanout_fanin";
    const angleFields = GATE_ANGLE_CONFIG[spec.name];
    const provenance = readProvenance
      ? await readLedgerProvenanceInAny(checkouts, ledgerPath, {
        requireProvenance, rejectForeignAngles, ...angleFields, config: angleConfig, gateKey: spec.name, hasFullLabel,
      })
      : null;
    gates.push({
      name: spec.name,
      executionMode: spec.marker.executionMode ?? null,
      inlineReason: spec.marker.inlineReason ?? null,
      scopeUnderThreshold,
      ledgerPath,
      ledgerExists: await ledgerExistsInAny(checkouts, ledgerPath),
      provenance,
      // The dispatch units THIS ledger's own fresh angles actually resolve to
      // (grouped or singleton, mode/gate:full-aware) — buildPreMergeGateCheck
      // re-validates the cardinality floor and the pairing exception against
      // this, so both agree with what readLedgerProvenanceInAny already used
      // to pick this ledger.
      resolvedGroups: resolveFanoutGroups(angleConfig, GATE_CONFIG_KEY[spec.name] ?? spec.name, freshAngleNames(provenance?.perAngle), { fullLabel: hasFullLabel }),
      ...angleFields,
    });
  }
  return { required: true, requireProvenance, rejectForeignAngles, lightMode, hasFullLabel, gates };
}
// Internal gatherer — carries the raw reviews/comments facts (comments carry
// FULL PR comment bodies) that buildPreMergeGateCheck needs. NOT exported:
// the only caller allowed to see those raw fields is this module's own
// main() below, which builds preMergeGateCheck from them and then discards
// them before emitting output. The exported detectCheckpointEvidence
// wrapper below strips them so no OTHER caller (e.g.
// detect-pr-gate-coordination-state.mjs, which durably stores the whole
// returned object) can re-expose them.
async function gatherCheckpointEvidenceRaw(options, { env = process.env, ghCommand = "gh", runChild = defaultRunChild, cwd = process.cwd() } = {}) {
  const runnerOwnership = await ensureAsyncRunnerOwnership({
    repo: options.repo,
    pr: options.pr,
    env,
    cwd,
    claimIfMissing: false,
    requireExisting: false,
  });
  if (!runnerOwnership.ok) {
    const error = new Error(runnerOwnership.message);
    error.runnerOwnership = runnerOwnership;
    throw error;
  }
  const staleRunnerDetection = await detectStaleRunner({
    repo: options.repo,
    pr: options.pr,
    cwd,
  });
  if (!staleRunnerDetection.ok) {
    const error = new Error(staleRunnerDetection.message);
    error.staleRunner = staleRunnerDetection;
    throw error;
  }
  const prPayload = await runGhJson(
    ["pr", "view", String(options.pr), "--repo", options.repo, "--json", "headRefOid"],
    { env, ghCommand, runChild, restFallback: () => restFetchPrView(options.repo, options.pr, env) },
  );
  const commentsPayload = normalizeIssueCommentsPayload(await runGhJson(
    ["api", "--paginate", "--slurp", `repos/${options.repo}/issues/${options.pr}/comments?per_page=100`],
    { env, ghCommand, runChild, restFallback: () => restGetPaginatedJson(`repos/${options.repo}/issues/${options.pr}/comments?per_page=100`, env) },
  ));
  const currentHeadSha = typeof prPayload?.headRefOid === "string" && prPayload.headRefOid.trim().length > 0
    ? prPayload.headRefOid.trim()
    : null;
  if (!currentHeadSha) {
    throw new Error("Invalid gh pr view payload: missing headRefOid");
  }
  // The PR review stream is the PRIMARY verdict surface: the poster renders the
  // round's single visible surface as a review. The issue-comment scan above is
  // the back-compat read that still sees legacy verdicts and the zero-dep
  // fallback poster's output. Both feed the same summarizers, so a verdict is
  // counted once wherever it lives.
  let prReviews = [];
  // Flat { login, state, commit_id, type } facts for the size-budget merge
  // gate below — the SAME shape merge-pr.mjs's own evaluateMergePreconditions
  // call feeds countUnresolvedHumanChangesRequested/verifyFreshHumanApproval,
  // kept separate from prReviews above (which is
  // normalized for the gate-review-comment marker summarizers instead). Only
  // SUBMITTED_REVIEW_STATES survive — a PENDING (unsubmitted draft) review
  // must never shadow an already-submitted APPROVED review from the same
  // login in the "last entry per login wins" resolvers below.
  let reviewFacts = [];
  // Distinct from "reviews fetched, zero reviews": a genuine read failure
  // must never be consumed by the size-budget merge gate as "zero blocking
  // reviews" (see buildPreMergeGateCheck below). Every other evidence
  // consumer (draftGate/preApprovalGate comment summarizers) still treats a
  // fetch failure as non-fatal, unchanged.
  let reviewsReadFailed = false;
  try {
    const reviewsRaw = await runGhJson(
      prReviewsApiArgs(options.repo, options.pr),
      { env, ghCommand, runChild, restFallback: () => restGetPaginatedJson(prReviewsApiPath(options.repo, options.pr), env) },
    );
    prReviews = normalizePrReviewsPayload(reviewsRaw);
    reviewFacts = flattenPaginatedSlurp(reviewsRaw)
      .filter((r) => SUBMITTED_REVIEW_STATES.has(r?.state))
      .map((r) => ({
        login: r?.user?.login ?? null, state: r?.state ?? null, commit_id: r?.commit_id ?? null, type: r?.user?.type ?? null,
      }));
  } catch {
    // Graceful fallback for the comment/verdict summarizers below: PR reviews
    // fetch failure is non-fatal there, and they continue with issue comments
    // only. The size-budget merge-authorization consumption is different —
    // see reviewsReadFailed above.
    reviewsReadFailed = true;
  }
  const commentFacts = commentsPayload.map((c) => ({
    login: c?.user?.login ?? null, body: c?.body ?? "", type: c?.user?.type ?? null,
  }));
  // Machine-artifact bodies are filtered inside the two summarizers below, not
  // here — see the import comment above.
  const allComments = [...commentsPayload, ...prReviews];
  const commentSummary = summarizeGateReviewComments(allComments);
  const markerSummary = summarizeGateReviewCommentMarkers(allComments, { headSha: currentHeadSha });
  const draftGateMarker = normalizeGateMarkerSummary(markerSummary.draft_gate);
  const preApprovalGateMarker = normalizeGateMarkerSummary(markerSummary.pre_approval_gate);
  // loadDevLoopConfig never throws: it returns { config, warnings, errors }.
  // A non-empty errors array means the config could not be loaded/validated, so
  // treat it as config-unavailable and leave fan-out enforcement disabled
  // (preserves default behavior). Other gate checks remain unaffected.
  let config = null;
  const { config: loadedConfig, errors: configErrors } = await loadDevLoopConfig({ repoRoot: resolveRepoRoot(cwd) });
  config = Array.isArray(configErrors) && configErrors.length > 0 ? null : loadedConfig;
  // Light-mode pre-merge facts: the base commit for the merge-base scope
  // re-derivation and whether the PR forces full fan-out via the gate:full label.
  // Fetched LAZILY — only when fan-out enforcement is active AND lightMode is on
  // AND a gate actually recorded an inline verdict — so the common fan-out path
  // (and every existing caller/test) makes NO extra gh call and stays unchanged.
  let baseRef = null;
  let hasFullLabel = false;
  const anyInlineVerdict = [draftGateMarker, preApprovalGateMarker].some(
    (marker) => marker.visible && marker.executionMode === "inline_single_agent",
  );
  if (config != null && resolveRequireFanoutEvidence(config) && resolveLightMode(config) != null && anyInlineVerdict) {
    try {
      const lightFacts = await runGhJson(
        ["pr", "view", String(options.pr), "--repo", options.repo, "--json", "baseRefOid,labels"],
        { env, ghCommand, runChild, restFallback: () => restFetchPrView(options.repo, options.pr, env) },
      );
      baseRef = typeof lightFacts?.baseRefOid === "string" && lightFacts.baseRefOid.trim().length > 0
        ? lightFacts.baseRefOid.trim()
        : null;
      hasFullLabel = Array.isArray(lightFacts?.labels)
        && lightFacts.labels.some((label) => (typeof label === "string" ? label : label?.name) === GATE_FULL_LABEL);
    } catch {
      // Fail CLOSED: without the label/base facts we cannot safely accept an
      // inline verdict, so leave baseRef null (scope underivable → rejected).
    }
  }
  const fanoutEnforcement = await buildFanoutEnforcement({
    repo: options.repo,
    pr: options.pr,
    currentHeadSha,
    draftGateMarker,
    preApprovalGateMarker,
    config,
    cwd,
    hasFullLabel,
    baseRef,
  });
  return {
    ok: true,
    repo: options.repo,
    pr: options.pr,
    currentHeadSha,
    draftGate: normalizeGateSummary(commentSummary.draft_gate),
    preApprovalGate: normalizeGateSummary(commentSummary.pre_approval_gate),
    draftGateMarker,
    preApprovalGateMarker,
    draftGateSatisfied: commentSummary.draft_gate?.verdict === "clean" && typeof commentSummary.draft_gate?.headSha === "string",
    // Additive: reviews/comments in the flat shape the size-budget merge gate
    // needs (buildPreMergeGateCheck below). Never consumed by the gate-review-
    // comment marker summarizers above — those use prReviews/allComments. Kept
    // on THIS internal object only — the exported detectCheckpointEvidence
    // wrapper strips them before returning (see the comment on
    // gatherCheckpointEvidenceRaw above).
    reviews: reviewFacts,
    comments: commentFacts,
    // A small flag (not raw data) — safe to keep on every projection,
    // including the exported wrapper's public result, so
    // buildPreMergeGateCheck's fail-closed handling is reachable without
    // threading the raw reviews array through it.
    reviewsReadFailed,
    fanoutEnforcement,
    ...(runnerOwnership.status !== "skipped_no_async_run_id" ? { runnerOwnership } : {}),
    staleRunner: {
      status: staleRunnerDetection.status,
      activeRun: staleRunnerDetection.activeRun,
      exitSignals: staleRunnerDetection.exitSignal?.signals ?? [],
      staleRunner: staleRunnerDetection.staleRunner,
      maxAgeMs: staleRunnerDetection.maxAgeMs,
      filePath: staleRunnerDetection.filePath,
    },
  };
}
/**
 * Public entry point. Same facts as {@link gatherCheckpointEvidenceRaw} minus
 * the raw `reviews`/`comments` arrays (comments carry full PR comment
 * bodies) — those are size-budget-gate input facts consumed only inside this
 * module's own main() via buildPreMergeGateCheck, and must never be a
 * durable field on the object handed to callers outside this file (e.g.
 * detect-pr-gate-coordination-state.mjs, which stores this whole result
 * under `gateEvidence`) — kept off every public projection regardless of how
 * many comments the PR has accumulated.
 *
 * ADR 0088 fold: `draftGateSatisfied` must assert 0
 * unresolved gate-authored threads, not just a clean verdict marker — the
 * same invariant main() below computes (its own fetch + login-narrowed
 * count). Previously this library entry point returned ONLY the
 * marker-only value, so the identical unresolved gate-authored question
 * could read `draftGateSatisfied: true` here (e.g. via
 * detect-pr-gate-coordination-state.mjs's own `gateEvidence`) while the CLI
 * reported it blocked.
 *
 * Deliberately caller-INJECTED rather than self-fetched here:
 * `ctx.unresolvedGateThreadCount`, when a finite number, folds it in; when
 * omitted, this returns the unchanged marker-only value. This entry point
 * never spends an unconditional extra thread-payload fetch (and conditional
 * `gh api user` round-trip) on every caller regardless of whether that
 * caller even reads `draftGateSatisfied` (most don't — e.g.
 * reconcile-draft-gate.mjs never does). detect-pr-gate-coordination-state.mjs
 * already resolves this identical login-narrowed count for its own
 * unrelated bookkeeping (ADR 0088) and injects it here, so the fold costs it
 * no second thread-payload fetch or second `gh api user` round-trip for the
 * same fact.
 */
export async function detectCheckpointEvidence(options, ctx) {
  const { reviews: _reviews, comments: _comments, ...publicResult } = await gatherCheckpointEvidenceRaw(options, ctx);
  if (typeof ctx?.unresolvedGateThreadCount === "number") {
    publicResult.draftGateSatisfied = publicResult.draftGateSatisfied && ctx.unresolvedGateThreadCount === 0;
  }
  return publicResult;
}
async function main() {
  let options;
  try {
    options = parseDetectCheckpointEvidenceCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  try {
    // Deliberately the internal raw gatherer, not the exported
    // detectCheckpointEvidence wrapper: this main() needs the raw
    // reviews/comments facts for buildPreMergeGateCheck below, and strips
    // them itself before emitting output (see serializableResult below).
    const result = await gatherCheckpointEvidenceRaw(options);
    let unresolvedThreadCount = -1;
    let unresolvedGateThreadCount = -1;
    try {
      const threadsPayload = await fetchGithubReviewThreadsPayload(options, { env: process.env });
      const parsedThreads = parseReviewThreads(threadsPayload);
      unresolvedThreadCount = coerceUnresolvedThreadCount(parsedThreads);
      // The draftGateSatisfied field must assert 0 unresolved gate-authored
      // threads (high, medium, low, question, AND nit), not just a clean
      // verdict. Narrowed by the authenticated gate login (ADR 0088), the
      // same way detect-pr-gate-coordination-state.mjs narrows its own
      // count from the same raw payload shape: a marker-only match from a
      // FOREIGN author (a thread that merely quotes a gate marker) must not
      // count here either, or the two detectors can disagree on the same PR
      // state (a foreign marker-quoting thread would block this detector's
      // draftGateSatisfied while the coordination detector's login-narrowed
      // count already reports 0). The `gh api user` round-trip only runs
      // when the cheap marker-only pass finds at least one candidate —
      // login narrowing can only SHRINK that count, so a marker-only 0
      // already proves the exact-author count is 0 too. A login-resolution
      // failure fails closed to -1, same as an unreadable thread payload.
      // Its own try/catch: a `gh api user` failure here must fail closed
      // ONLY unresolvedGateThreadCount, never overwrite the already-computed
      // unresolvedThreadCount above (that count is unrelated to the login
      // lookup and buildPreMergeGateCheck's diagnostic depends on it staying
      // accurate).
      try {
        const markerOnlyGateThreadCount = countUnresolvedGateAuthoredThreadsFromRawNodes(threadsPayload);
        if (markerOnlyGateThreadCount === 0) {
          unresolvedGateThreadCount = 0;
        } else {
          const login = await resolveAuthenticatedLogin({ env: process.env });
          unresolvedGateThreadCount = countUnresolvedGateAuthoredThreadsFromRawNodes(threadsPayload, login);
        }
      } catch {
        unresolvedGateThreadCount = -1;
      }
    } catch {
      unresolvedThreadCount = -1;
      unresolvedGateThreadCount = -1;
    }
    // Fold the gate-authored thread invariant into draftGateSatisfied.
    result.draftGateSatisfied = result.draftGateSatisfied && unresolvedGateThreadCount === 0;
    const staleRunnerCheck = {
      ok: result.staleRunner.status === "fresh_runner" || result.staleRunner.status === "no_owner_record",
      failures: result.staleRunner.status === "stale_runner"
        ? [`stale runner: ${result.staleRunner.staleRunner?.runId} claimed ${result.staleRunner.staleRunner?.claimedAgeMs}ms ago, last updated ${result.staleRunner.staleRunner?.updatedAgeMs}ms ago (max age ${result.staleRunner.staleRunner?.maxAgeMs}ms)`]
        : result.staleRunner.status === "exit_signal_recorded"
        ? [`exit signal recorded for run ${result.staleRunner.activeRun?.runId}: refuse to merge`]
        : [],
    };
    const preMergeGateCheck = buildPreMergeGateCheck(result, unresolvedThreadCount, staleRunnerCheck, result.fanoutEnforcement, { skipFanoutLedgerCheck: options.skipFanoutLedgerCheck === true });
    const evidenceState = deriveEvidenceState(result, preMergeGateCheck);
    // reviews/comments are raw size-budget-gate input facts (comments carry
    // FULL PR comment bodies) consumed internally by buildPreMergeGateCheck
    // above; they are never read from the CLI's own JSON output by any
    // consumer (merge-pr.mjs reads only preMergeGateCheck.failures), so they
    // are excluded here to keep emitted output bounded regardless of how many
    // comments the PR has accumulated.
    const { reviews: _reviews, comments: _comments, ...serializableResult } = result;
    const output = { ...serializableResult, preMergeGateCheck, staleRunnerCheck, evidenceState };
    if (!preMergeGateCheck.ok) {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        error: `Pre-merge gate evidence check failed: ${preMergeGateCheck.failures.join("; ")}`,
        repo: result.repo,
        pr: result.pr,
        currentHeadSha: result.currentHeadSha,
        preMergeGateCheck,
        staleRunnerCheck,
        staleRunner: result.staleRunner,
        evidenceState,
      })}\n`);
      process.exitCode = 1;
      return;
    }
    // Warnings (e.g. foreign angles under gates.rejectForeignAngles: false) do
    // not fail the check but must not pass silently. Suppressed under --silent.
    if (Array.isArray(preMergeGateCheck.warnings) && !options.silent) {
      for (const warning of preMergeGateCheck.warnings) {
        process.stderr.write(`WARNING: ${warning}\n`);
      }
    }
    process.exitCode = emitResult(output, { jq: options.jq, silent: options.silent, fields: options.fields });
  } catch (error) {
    if (error && typeof error === "object" && "staleRunner" in error && error.staleRunner) {
      const staleRunnerCheck = {
        ok: false,
        failures: error.staleRunner.status === "stale_runner"
          ? [`stale runner: ${error.staleRunner.staleRunner?.runId} claimed ${error.staleRunner.staleRunner?.claimedAgeMs}ms ago, last updated ${error.staleRunner.staleRunner?.updatedAgeMs}ms ago (max age ${error.staleRunner.staleRunner?.maxAgeMs}ms)`]
          : error.staleRunner.status === "exit_signal_recorded"
          ? [`exit signal recorded for run ${error.staleRunner.activeRun?.runId}: refuse to merge`]
          : [],
      };
      process.stderr.write(`${JSON.stringify({
        ok: false,
        error: error.staleRunner.error,
        status: error.staleRunner.status,
        message: error.staleRunner.message,
        staleRunner: {
          status: error.staleRunner.status,
          activeRun: error.staleRunner.activeRun,
          exitSignals: error.staleRunner.exitSignal?.signals ?? [],
          staleRunner: error.staleRunner.staleRunner,
          maxAgeMs: error.staleRunner.maxAgeMs,
          filePath: error.staleRunner.filePath,
        },
        staleRunnerCheck,
      })}\n`);
      process.exitCode = 1;
      return;
    }
    if (error && typeof error === "object" && "runnerOwnership" in error && error.runnerOwnership) {
      process.stderr.write(`${JSON.stringify(error.runnerOwnership)}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}
if (isDirectCliRun(import.meta.url)) {
  await main();
}
