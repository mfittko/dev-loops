#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  buildParseError,
  formatCliError,
  isDirectCliRun,
  parseJsonText,
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
import path from "node:path";
import { parsePrNumber, requireTokenValue, runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { fetchGithubReviewThreadsPayload } from "./capture-review-threads.mjs";
import { isGhBinaryMissing, restFetchPrView, restGetPaginatedJson } from "./_gh-rest-fallback.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { FANOUT_PROVENANCE_MIN_REVIEWERS, GATE_FULL_LABEL, loadDevLoopConfig, resolveGateAngleContract, resolveGateConfig, resolveLightMode, resolveRejectForeignAngles, resolveRequireFanoutEvidence, resolveRequireFanoutProvenance } from "@dev-loops/core/config";
import { FANOUT_UNAVAILABLE_MESSAGE, checkFanoutAngleCoverage, countFreshAngles, fanoutReviewerPairingError, provenanceConsistencyError } from "@dev-loops/core/loop/gate-fanin";
import { detectMergeBaseScope, isEligibleForLightMode } from "../loop/detect-change-scope.mjs";
import { buildLogPath } from "./write-gate-findings-log.mjs";
import { normalizePrReviewsPayload, prReviewsApiArgs, prReviewsApiPath } from "./_gate-finding-surface.mjs";
import { ensureAsyncRunnerOwnership } from "../loop/_pr-runner-coordination.mjs";
import { detectStaleRunner } from "../loop/_stale-runner-detection.mjs";
import { resolveLedgerCheckouts, resolveRepoRoot } from "../loop/_repo-root-resolver.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
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
// error and is never silently retried through the REST fallback (#1358).
async function runGhJson(args, { env, ghCommand, runChild = defaultRunChild, restFallback = null }) {
  let result;
  try {
    result = await runChild(ghCommand, args, env);
  } catch (error) {
    if (restFallback && isGhBinaryMissing(error)) {
      return await restFallback();
    }
    throw error;
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  return parseJsonText(result.stdout, { label: `gh ${args.slice(0, 2).join(" ")}` });
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
    surface: summary.surface ?? "issue_comment",
    headSha: summary.headSha,
    verdict: summary.verdict,
    findingsSummary: summary.findingsSummary,
    nextAction: summary.nextAction,
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
    surface: summary.surface ?? "issue_comment",
    headSha: summary.headSha,
    verdict: summary.verdict,
    findingsSummary: summary.findingsSummary,
    nextAction: summary.nextAction,
    executionMode: summary.executionMode ?? null,
    inlineReason: summary.inlineReason ?? null,
    contractComplete: summary.contractComplete === true,
    commentId: summary.commentId,
    commentUrl: summary.commentUrl,
    updatedAt: summary.updatedAt,
  };
}
export function buildPreMergeGateCheck(evidence, unresolvedThreadCount = null, staleRunnerCheck = null, fanoutEnforcement = null, { skipFanoutLedgerCheck = false } = {}) {
  const failures = [];
  const warnings = [];
  if (!(evidence.draftGate.visible && evidence.draftGate.verdict === "clean")) {
    failures.push("missing visible clean draft_gate comment");
  }
  const preApproval = evidence.preApprovalGateMarker;
  if (!(
    preApproval.visible
    && preApproval.contractComplete
    && preApproval.verdict === "clean"
    && preApproval.headSha === evidence.currentHeadSha
  )) {
    failures.push("missing visible clean current-head pre_approval_gate comment");
  }
  // Fail-closed fan-out evidence enforcement (gates.requireFanoutEvidence, ON by
  // default / opt-out). When disabled or config-unavailable, fanoutEnforcement is
  // { required: false, gates: [] } so the `.required` guard skips this block.
  if (fanoutEnforcement && fanoutEnforcement.required) {
    for (const gate of fanoutEnforcement.gates) {
      // Light-mode acceptance (#1174): a genuinely under-threshold micro-PR
      // collapses the gate fan-out to a single inline check (#1043). Accept that
      // inline verdict ONLY when ALL hold, fail CLOSED otherwise:
      //   - lightMode is enabled in config, AND
      //   - the reviewed head's merge-base scope was RE-DERIVED under threshold
      //     (scopeUnderThreshold; false whenever scope could not be derived), AND
      //   - the PR carries no gate:full label (which always forces fan-out), AND
      //   - the verdict records a non-empty inline reason.
      // Any non-light inline verdict (over threshold / label / lightMode off /
      // scope underivable) falls through to the byte-identical rejection below.
      const lightAccepted =
        gate.executionMode === "inline_single_agent"
        && fanoutEnforcement.lightMode === true
        && fanoutEnforcement.hasFullLabel !== true
        && gate.scopeUnderThreshold === true
        && typeof gate.inlineReason === "string"
        && gate.inlineReason.trim().length > 0;
      if (gate.executionMode !== "fanout_fanin" && !lightAccepted) {
        failures.push(
          `${gate.name}: requireFanoutEvidence is enabled but executionMode is "${gate.executionMode ?? "unset"}" (expected "fanout_fanin"); inline gate verdicts are not accepted`,
        );
        continue;
      }
      // A stateless remote verifier (the gate-evidence CI check, or a gh-less API
      // session) never has the gitignored, worktree-local tmp/gate-findings ledger
      // on disk — only the machine that ran the review does. skipFanoutLedgerCheck
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
      // Provenance is enforced ONLY for fanout_fanin verdicts (#1174): a
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
          // The floor scales with the fresh (non-carried) angle count: one
          // reviewer per fresh angle at minimum FANOUT_PROVENANCE_MIN_REVIEWERS
          // (#1431) — a ledger recording more fresh angles than distinct
          // reviewers could only have paired one reviewer across angles.
          const freshAngleCount = countFreshAngles(prov.perAngle);
          const requiredReviewers = Math.max(FANOUT_PROVENANCE_MIN_REVIEWERS, freshAngleCount);
          // Re-validate the per-identity pairing here too: the ledger is a
          // worktree-local file, so the read path must not trust that the
          // write-time floor produced it (a hand-crafted padded ledger can
          // satisfy the cardinality floor while one reviewer covers two
          // fresh angles).
          const pairingErr = fanoutReviewerPairingError(prov.perAngle);
          if (reviewers === null || reviewers < requiredReviewers) {
            failures.push(
              `${gate.name}: requireFanoutProvenance is enabled but the findings-log ledger lacks valid fan-out provenance (need provenance.distinctReviewers >= ${requiredReviewers}${requiredReviewers > FANOUT_PROVENANCE_MIN_REVIEWERS ? ` [max(${FANOUT_PROVENANCE_MIN_REVIEWERS}, ${freshAngleCount} fresh angle(s))]` : ""}, got ${reviewers === null ? "none" : reviewers}); ${FANOUT_UNAVAILABLE_MESSAGE}`,
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
 * Classify WHY the checkpoint-evidence pre-merge check is (un)satisfied, for the
 * gate-evidence commit-status mapping: `not_established` (evidence for the
 * current head simply doesn't exist yet — draft, mid-Copilot-loop, or right
 * after a fix commit before pre_approval_gate re-runs) reads as `pending`, not
 * `failure`; `violation` (a visible current-head comment carries a bad verdict —
 * blocked/findings_present — or another pre-merge check failed, e.g. unresolved
 * threads or a stale runner) reads as `failure`; `satisfied` reads as `success`.
 * Both gates clean is a precondition for `satisfied`, not the definition of it —
 * a clean-gates PR can still fail on an unrelated pre-merge failure, which is a
 * real problem (violation), not "waiting".
 *
 * @param {{ draftGate: object, preApprovalGateMarker: object }} evidence
 * @param {{ ok: boolean }} preMergeGateCheck
 * @returns {"satisfied"|"not_established"|"violation"}
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
 * (main + every worktree). Fixes #1050: a ledger written in the PR worktree is
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
  const { requireProvenance = false, mandatoryAngles = [], anglePool = null, rejectForeignAngles = true } = criteria;
  const satisfies = (prov) => {
    if (provenanceConsistencyError(prov) !== null) return false;
    if (requireProvenance && prov.distinctReviewers < Math.max(FANOUT_PROVENANCE_MIN_REVIEWERS, countFreshAngles(prov.perAngle))) return false;
    if (requireProvenance && fanoutReviewerPairingError(prov.perAngle) !== null) return false;
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
/**
 * Build the fan-out evidence enforcement descriptor.
 *
 * Enforcement is ON by default (opt-out via gates.requireFanoutEvidence: false).
 * Returns { required: false } when enforcement is disabled OR when config is
 * unavailable (config == null — null or undefined — after a failed load) — config-unavailable must
 * fail open and never enable enforcement. When enabled, returns
 * { required: true, requireProvenance, lightMode, hasFullLabel, gates } where
 * each per-required-gate entry records executionMode, inlineReason,
 * scopeUnderThreshold, and whether the deterministic findings-log ledger exists
 * for the reviewed head SHA, so the pre-merge check can fail closed on inline
 * verdicts or missing ledgers.
 *
 * Light mode (#1174): when gates.lightMode is configured, `hasFullLabel`
 * (gate:full PR label) and `baseRef` feed a fail-closed merge-base scope
 * re-derivation for inline verdicts. A gate's scopeUnderThreshold is true only
 * when light mode is on, the PR has no gate:full label, a base ref is known,
 * and the reviewed head's merge-base diff is genuinely under threshold — which
 * lets the pre-merge check accept an inline single-agent verdict for a
 * small-scope PR instead of always rejecting inline evidence.
 */
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
  // Light-mode facts (#1174): the threshold that a re-derived merge-base scope
  // must fall under for an inline verdict to be accepted. null when lightMode is
  // disabled → no inline verdict can ever be accepted (scopeUnderThreshold stays
  // false), preserving today's rejection.
  const lightThreshold = resolveLightMode(config);
  const lightMode = lightThreshold != null;
  const draftGateConfig = resolveGateConfig(config, "draft");
  const preApprovalGateConfig = resolveGateConfig(config, "preApproval");
  // Shared angle-contract resolver (exclude-filtered mandatory angles +
  // additive-aware pool) — the same contract the write paths enforce. The
  // field names here (`mandatoryAngles`/`anglePool`) are exactly what
  // buildPreMergeGateCheck reads off each gate entry.
  const buildAngleFields = (gateKey) => {
    const { mandatoryAngles, pool } = resolveGateAngleContract(config, gateKey);
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
  const checkouts = resolveLedgerCheckouts(cwd);
  // checkouts[0] is always resolveRepoRoot(cwd) (resolveLedgerCheckouts adds it
  // first, unconditionally, and never throws — it falls back to cwd on git
  // failure) — reuse it instead of a second `git rev-parse --show-toplevel`.
  const repoRoot = checkouts[0];
  for (const spec of gateSpecs) {
    const headSha = spec.marker.headSha ?? currentHeadSha;
    const ledgerPath = buildLogPath({ repo, pr, gate: spec.name, headSha, tmpRoot: "tmp" });
    // Re-derive scope FAIL-CLOSED for inline verdicts only (the fan-out default
    // path pays no git I/O). scopeUnderThreshold is true ONLY when lightMode is
    // on, the PR has no gate:full label, a base ref is known, and the merge-base
    // diff for the reviewed head is genuinely under threshold. Any git/scope
    // failure leaves it false, so the inline verdict is rejected exactly as today.
    let scopeUnderThreshold = false;
    if (lightMode && !hasFullLabel && baseRef && spec.marker.executionMode === "inline_single_agent") {
      const scope = detectMergeBaseScope({ base: baseRef, head: headSha, cwd: repoRoot });
      scopeUnderThreshold = scope.ok === true && isEligibleForLightMode(scope, lightThreshold);
    }
    // Read ledger provenance for ANY fanout_fanin gate (not just when
    // requireProvenance is on): angle-coverage enforcement re-validates
    // whatever provenance is recorded independently of that opt-in flag.
    // The selection criteria mirror the full active enforcement so a stale
    // checkout's contract-failing ledger cannot shadow a passing one.
    const readProvenance = requireProvenance || spec.marker.executionMode === "fanout_fanin";
    const angleFields = GATE_ANGLE_CONFIG[spec.name];
    gates.push({
      name: spec.name,
      executionMode: spec.marker.executionMode ?? null,
      inlineReason: spec.marker.inlineReason ?? null,
      scopeUnderThreshold,
      ledgerPath,
      ledgerExists: await ledgerExistsInAny(checkouts, ledgerPath),
      provenance: readProvenance
        ? await readLedgerProvenanceInAny(checkouts, ledgerPath, { requireProvenance, rejectForeignAngles, ...angleFields })
        : null,
      ...angleFields,
    });
  }
  return { required: true, requireProvenance, rejectForeignAngles, lightMode, hasFullLabel, gates };
}
export async function detectCheckpointEvidence(options, { env = process.env, ghCommand = "gh", runChild = defaultRunChild, cwd = process.cwd() } = {}) {
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
  // Also scan PR reviews for gate comments posted via the review API.
  // This prevents duplicates when an escape-hatch path posted a gate verdict
  // as a PR review rather than an issue comment (root cause 3 from issue #692).
  let prReviews = [];
  try {
    const reviewsRaw = await runGhJson(
      prReviewsApiArgs(options.repo, options.pr),
      { env, ghCommand, runChild, restFallback: () => restGetPaginatedJson(prReviewsApiPath(options.repo, options.pr), env) },
    );
    prReviews = normalizePrReviewsPayload(reviewsRaw);
  } catch {
    // Graceful fallback: PR reviews fetch failure is non-fatal.
    // We continue with issue comments only.
  }
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
  // Light-mode pre-merge facts (#1174): the base commit for the merge-base scope
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
    const result = await detectCheckpointEvidence(options);
    let unresolvedThreadCount = -1;
    try {
      const threadsPayload = await fetchGithubReviewThreadsPayload(options, { env: process.env });
      const parsedThreads = parseReviewThreads(threadsPayload);
      unresolvedThreadCount = parsedThreads?.summary?.unresolvedThreads ?? 0;
    } catch {
      unresolvedThreadCount = -1;
    }
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
    const output = { ...result, preMergeGateCheck, staleRunnerCheck, evidenceState };
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
    process.exitCode = emitResult(output, { jq: options.jq, silent: options.silent });
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
