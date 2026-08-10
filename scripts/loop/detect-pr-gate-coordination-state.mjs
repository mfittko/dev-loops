#!/usr/bin/env node
import path from "node:path";
import {
  buildParseError,
  formatCliError,
  isCopilotLogin,
  isDirectCliRun,
  parseJsonText,
  parseReviewThreads,
  resolveDraftGateRoundResetMs,
  summarizeCopilotReviews,
} from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { loadDevLoopConfig, resolveEffectiveCopilotRoundCap, resolveGateConfig, resolveRefinement, resolveRefinementConfig } from "@dev-loops/core/config";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { buildSnapshotFromPrFacts, interpretLoopState, isCopilotRoundCapReached, summarizeLoopInterpretation } from "@dev-loops/core/loop/copilot-loop-state";
import { evaluatePrGateCoordination, isRoundCapReachedCleanGrant, PR_CHECKPOINT, PR_CHECKPOINT_ACTION, REFINEMENT_ARTIFACT_SPEC_SOURCE } from "@dev-loops/core/loop/pr-gate-coordination";
import { shouldGuardCopilotReviewRequest } from "@dev-loops/core/loop/pr-gate-coordination";
import { PLAN_FILE_PROMOTION_DOC_PATH_PATTERN } from "@dev-loops/core/loop/plan-file-promote-contract";
import { UI_E2E_CHECK_NAMES } from "@dev-loops/core/loop/ui-e2e-scoping";
import { fetchGithubReviewThreadsPayload } from "../github/capture-review-threads.mjs";
import { detectPostConvergenceSignificantChange } from "./_post-convergence-change.mjs";
import { detectCheckpointEvidence } from "../github/detect-checkpoint-evidence.mjs";
import { classifyDeltaSinceLastReview, getLastCopilotReviewHeadSha } from "../github/request-copilot-review.mjs";
import { readSuppressionMarker } from "./_post-convergence-review-suppression.mjs";
import { resolveRepoRoot } from "./_repo-root-resolver.mjs";
import { releaseAsyncRunnerOwnership } from "./_pr-runner-coordination.mjs";
import { fetchCopilotRequested, resolveCopilotReviewRequestStatus } from "./_copilot-review-request-status.mjs";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
// Gate-coordination terminal stop actions where the dev-loop run is completing or
// stopping (success OR stop). The runner-coordination lock is auto-released at these
// boundaries so a fresh re-dispatch on the same PR acquires the lock without a
// takeover (#1632). The Copilot-loop terminal release in `loop handoff` (#1128)
// only covers Copilot-loop terminal states (CLEAN_CONVERGED / BLOCKED / DONE); a
// merge-ready PR that is NOT in a Copilot-loop terminal state (e.g. an
// internal-only PR at `pr_ready_no_feedback`, or a local-implementation gate
// drive that stops at the approval checkpoint without a terminal handoff) would
// otherwise hold a stale claim until the 30-min TTL. This set is the
// gate-coordination counterpart: it fires at every run-completion/stop boundary
// the agent reaches via this detector. `releaseAsyncRunnerOwnership` is
// env-aware (no-op without DEVLOOPS_RUN_ID) and best-effort/non-fatal, so it is
// safe for the conductor (polls all PRs with no run id) and read-only
// inspections — it only ever clears a claim THIS run owns.
const TERMINAL_RUNNER_RELEASE_ACTIONS = new Set([
  PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL,
  PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
  PR_CHECKPOINT_ACTION.REPORT_DONE,
  PR_CHECKPOINT_ACTION.REPORT_BLOCKED,
]);
const UNMERGED_GIT_STATUS_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const USAGE = `Usage: detect-pr-gate-coordination-state.mjs --repo <owner/name> --pr <number>
Determine which PR gate/transition is legal next for a pull request.
Required:
  --repo <owner/name>   Repository slug (e.g. owner/repo)
  --pr <number>         Pull request number
Optional:
  --lightweight   This PR is light-dispatched (#1210): compose the Copilot
                  round cap with localImplementation.lightMode.maxCopilotRounds
                  (default 1) via min(lightMode.maxCopilotRounds,
                  refinement.maxCopilotRounds) instead of using
                  refinement.maxCopilotRounds alone. refinement.maxCopilotRounds:
                  0 still disables Copilot rounds even with --lightweight.
Output (stdout, JSON):
  {
    "ok": true,
    "repo": "owner/repo",
    "pr": 266,
    "currentHeadSha": "...",
    "mergeStateStatus": "DIRTY",
    "conflictFiles": ["config.test.mjs", "extension/README.md"],
    "lifecycleState": "pr_ready_no_feedback",
    "loopDisposition": "action_required",
    "gateBoundary": "conflict_resolution",
    "draftGate": {
      "visible": true,
      "markerVisible": false,
      "anyVisible": true,
      "currentHead": false,
      "contractComplete": false,
      "currentHeadClean": false,
      "headSha": "c94679e",
      "verdict": "clean"
    },
    "preApprovalGate": {
      "visible": false,
      "markerVisible": false,
      "anyVisible": false,
      "currentHead": false,
      "contractComplete": false,
      "currentHeadClean": false,
      "headSha": null,
      "verdict": null
    },
    "refinementArtifact": {
      "status": "present",
      "specSource": "linked_issue",
      "reason": "...",
      "finding": null
    },
    "allowedNextActions": ["resolve_merge_conflicts"],
    "forbiddenActions": ["run_pre_approval_gate", "declare_merge_ready"],
    "nextAction": "resolve_merge_conflicts",
    "reason": "..."
  }
  (refinementArtifact.planDocPath is present only when specSource is
  "plan_file"; the key is omitted entirely for "linked_issue" and "pr_body")
Error output (stderr, JSON):
  { "ok": false, "error": "...", "usage": "..." }
  { "ok": false, "error": "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error or gh/runtime failure
  2  Invalid --jq filter`.trim();
const parseError = buildParseError(USAGE);
export function parseDetectPrGateCoordinationCliArgs(argv) {
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
    lightweight: false,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      lightweight: { type: "boolean" },
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
    if (token.name === "repo") {
      options.repo = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "pr") {
      options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError);
      continue;
    }
    if (token.name === "lightweight") {
      options.lightweight = true;
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined || options.pr === undefined) {
    throw parseError("detect-pr-gate-coordination-state requires both --repo <owner/name> and --pr <number>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}
export function parseGitStatusConflictFiles(text) {
  if (typeof text !== "string" || text.length === 0) {
    return [];
  }
  const records = text.includes("\0")
    ? text.split("\0")
    : text.split(/\r?\n/);
  const conflictFiles = [];
  for (const rawRecord of records) {
    if (rawRecord.length < 4) {
      continue;
    }
    const status = rawRecord.slice(0, 2);
    if (!UNMERGED_GIT_STATUS_CODES.has(status)) {
      continue;
    }
    const rawPath = rawRecord.slice(3);
    if (rawPath.trim().length > 0 && !conflictFiles.includes(rawPath)) {
      conflictFiles.push(rawPath);
    }
  }
  return conflictFiles;
}
async function fetchPrFacts({ repo, pr }, { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {}) {
  const result = await runChild(
    ghCommand,
    ["pr", "view", String(pr), "--repo", repo, "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  return parseJsonText(result.stdout, { label: "gh pr view" });
}

// GitHub computes `mergeable` asynchronously, so a freshly-pushed head briefly
// reads `UNKNOWN`. After the initial fetch, re-poll up to `maxPolls` more times
// while the value stays UNKNOWN (so at most 1 + maxPolls total fetches) before
// deciding; never treat a transient UNKNOWN as a pass — the caller fails closed
// to recheck if it never settles. (issue #980)
export async function fetchPrFactsWithSettledMergeable(
  options,
  {
    env = process.env,
    ghCommand = "gh",
    runChild = defaultRunChild,
    maxPolls = 3,
    pollDelayMs = 1500,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    fetch = fetchPrFacts,
  } = {},
) {
  let prData = await fetch(options, { env, ghCommand, runChild });
  let polls = 0;
  while (String(prData?.mergeable || "").toUpperCase() === "UNKNOWN" && polls < maxPolls) {
    polls += 1;
    await sleep(pollDelayMs);
    prData = await fetch(options, { env, ghCommand, runChild });
  }
  return prData;
}
// Changed-file paths from `gh pr view --json files` (issue #976). Feeds the
// path-triggered UI e2e scoping precondition in the evaluator.
export function extractChangedFiles(prData) {
  const files = Array.isArray(prData?.files) ? prData.files : [];
  return files
    .map((entry) => (typeof entry?.path === "string" ? entry.path : null))
    .filter((p) => typeof p === "string" && p.length > 0);
}

// Whether the shared UI e2e suite passed for this head, read deterministically
// from the statusCheckRollup: every UI e2e check that is present must be
// SUCCESS. Returns null when no UI e2e check is present in the rollup (unknown
// → the evaluator fails closed), false if any present UI e2e check is not a
// success, true if all present ones succeeded.
export function deriveUiE2ePassed(prData, checkNames = UI_E2E_CHECK_NAMES) {
  const rollup = Array.isArray(prData?.statusCheckRollup) ? prData.statusCheckRollup : [];
  const wanted = new Set(checkNames);
  const present = rollup.filter((entry) => wanted.has(entry?.name) || wanted.has(entry?.context));
  if (present.length === 0) return null;
  return present.every((entry) => {
    const conclusion = String(entry?.conclusion ?? "").toUpperCase();
    const state = String(entry?.state ?? "").toUpperCase();
    // SKIPPED = "not applicable to this run" (e.g. viewer-smoke when no viewer files changed) — not a failure.
    return conclusion === "SUCCESS" || conclusion === "SKIPPED" || state === "SUCCESS" || state === "SKIPPED";
  });
}

// Ordered, de-duplicated list of ALL closing-referenced issue numbers for a PR.
// Umbrella PRs legitimately close multiple issues (#1052), so the refinement
// guard resolves against every one of them, not just a unique single ref.
export function resolveLinkedIssuesFromPr(prData) {
  if (!prData || typeof prData !== "object") return [];
  const dedupe = (nums) => {
    const seen = new Set();
    const out = [];
    for (const n of nums) {
      if (Number.isInteger(n) && n > 0 && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
    return out;
  };
  const closing = Array.isArray(prData.closingIssuesReferences) ? prData.closingIssuesReferences : [];
  const closingNumbers = dedupe(closing.map((entry) => Number(entry?.number)));
  if (closingNumbers.length > 0) {
    return closingNumbers;
  }
  const body = typeof prData.body === "string" ? prData.body : "";
  if (body.length === 0) return [];
  const matches = body.match(/(?:closes|fixes|resolves)\s+#(\d+)/gi) || [];
  return dedupe(matches.map((m) => Number((/(\d+)/.exec(m) || [])[1])));
}

async function fetchIssueBody({ repo, issue }, { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {}) {
  const result = await runChild(
    ghCommand,
    ["issue", "view", String(issue), "--repo", repo, "--json", "body"],
    env,
  );
  if (result.code !== 0) {
    return null;
  }
  try {
    const payload = parseJsonText(result.stdout, { label: "gh issue view" });
    return typeof payload?.body === "string" ? payload.body : "";
  } catch {
    return null;
  }
}
// Plan-file promotion PRs (P4, `buildPromotionPrBody`) carry no linked issue by
// design; the PR body instead names the committed plan doc as the spec-of-record
// verbatim (marker owned by plan-file-promote-contract.mjs). Matching that
// literal marker is how the refinement check tells a promoted plan-file PR
// apart from an ordinary issue-less body.

// Resolve the refinement artifact for a draft PR with zero linked issues,
// directly from its own body. The sanctioned three-origin model
// (artifact-authority-contract.md) backs a draft PR with a linked issue, a
// promoted plan file, or the PR body itself as the spec-of-record; only the
// first fetches an issue body, so this never needs a network call.
// `specSource` here (linked_issue|pr_body|plan_file) is a distinct enum from
// handoff-envelope.mjs's CANONICAL_SPEC_SOURCE (phase_doc|pr_body): same field
// name, different object, different value space — never conflate the two.
async function resolveNoIssueRefinementArtifact(body) {
  const { detectIssueRefinementArtifact, validatePrBodySpec } = await import("@dev-loops/core/loop/issue-refinement-artifact");
  const planDocMatch = PLAN_FILE_PROMOTION_DOC_PATH_PATTERN.exec(body);
  if (planDocMatch) {
    const planDocPath = planDocMatch[1].trim();
    // The marker sentence alone is spoofable (any body can paste it): require the
    // body to still carry real AC/DoD checklist content, the same invariant
    // `buildPromotionPrBody` actually embeds, before trusting the plan-file claim.
    // Deliberately narrower than `artifact.hasACs`: that flag also turns true on a
    // bare linked-refinement-doc mention (no checklist items at all), which is the
    // right OR for a linked ISSUE body but not for a plan-file promotion PR body —
    // a plan-file claim must be backed by actual AC/DoD checklist items, not just
    // another doc mention next to the marker.
    // Plan-file promotion is issue-less by design (`buildPromotionPrBody`
    // neutralizes closing keywords): any closing reference the body carries —
    // including the cross-repo `owner/repo#N` form validatePrBodySpec also
    // accepts — means the body would auto-close an issue it doesn't actually
    // back. Reuse validatePrBodySpec's closing-reference extraction
    // (issueLess mode's `closesIssues`) instead of a second regex.
    const closesIssues = validatePrBodySpec({ body, issueLess: true }).closesIssues;
    if (closesIssues.length > 0) {
      return {
        status: "missing",
        linkedIssue: null,
        linkedIssues: [],
        specSource: REFINEMENT_ARTIFACT_SPEC_SOURCE.PLAN_FILE,
        planDocPath,
        reason: `PR body names the promoted plan doc \`${planDocPath}\` as the spec-of-record but also carries a GitHub closing reference (${closesIssues.map((n) => `#${n}`).join(", ")}); plan-file promotion is issue-less by design and must not carry a reference that would auto-close an issue it doesn't back.`,
        finding: "missing_refinement_artifact",
      };
    }
    const artifact = detectIssueRefinementArtifact({ body });
    if (artifact.acItems.length > 0 || artifact.dodItems.length > 0) {
      return {
        status: "present",
        linkedIssue: null,
        linkedIssues: [],
        specSource: REFINEMENT_ARTIFACT_SPEC_SOURCE.PLAN_FILE,
        planDocPath,
        acItems: artifact.acItems,
        dodItems: artifact.dodItems,
        sections: artifact.sections,
        reason: `Refinement artifact present via the promoted plan doc \`${planDocPath}\` the PR body carries as the spec-of-record (plan-file promotion; no linked issue required).`,
        finding: null,
      };
    }
    return {
      status: "missing",
      linkedIssue: null,
      linkedIssues: [],
      specSource: REFINEMENT_ARTIFACT_SPEC_SOURCE.PLAN_FILE,
      planDocPath,
      reason: `PR body names the promoted plan doc \`${planDocPath}\` as the spec-of-record but carries no Acceptance criteria / DoD checklist content (${artifact.reason}); a bare marker sentence cannot satisfy the refinement check.`,
      finding: "missing_refinement_artifact",
    };
  }
  const specResult = validatePrBodySpec({ body, issueLess: true });
  if (specResult.ok) {
    return {
      status: "present",
      linkedIssue: null,
      linkedIssues: [],
      specSource: REFINEMENT_ARTIFACT_SPEC_SOURCE.PR_BODY,
      acItems: specResult.acItems,
      dodItems: specResult.dodItems,
      sections: specResult.sections,
      reason: "Refinement artifact present via the PR body itself (issue-less lightweight PR-body-as-spec; validate-pr-body-spec --no-issue clean).",
      finding: null,
    };
  }
  return {
    status: "missing",
    linkedIssue: null,
    linkedIssues: [],
    specSource: REFINEMENT_ARTIFACT_SPEC_SOURCE.PR_BODY,
    reason: `PR body fails the issue-less lightweight spec-of-record validation (validate-pr-body-spec --no-issue: ${specResult.errors.map((e) => e.code).join(", ")}).`,
    finding: "missing_refinement_artifact",
  };
}

// Fetch and evaluate every closing-referenced issue. An umbrella PR's scope is
// refined if AT LEAST ONE linked issue carries a refinement artifact. Shared
// by the draft/closed/merged enforcement path AND the ready-PR informational
// path so the two never drift on what counts as a fetched/evaluated artifact.
// The ready-PR path reuses the SAME evaluated results to surface the
// spec-of-record's AC data (acItems/uncheckedAcItems) for the pre_approval_gate
// unticked-AC check (#1621) without re-deriving it.
async function evaluateLinkedIssueArtifacts(linkedIssues, { repo, env, ghCommand, runChild }) {
  const { detectIssueRefinementArtifact } = await import("@dev-loops/core/loop/issue-refinement-artifact");
  const evaluated = [];
  for (const issue of linkedIssues) {
    const body = await fetchIssueBody({ repo, issue }, { env, ghCommand, runChild });
    if (body === null) {
      evaluated.push({ issue, artifact: null });
      continue;
    }
    evaluated.push({ issue, artifact: detectIssueRefinementArtifact({ body, issueNumber: issue }) });
  }
  const refinedIssues = evaluated
    .filter((e) => e.artifact && e.artifact.hasACs === true)
    .map((e) => e.issue);
  const firstPresent = evaluated.find((e) => e.artifact && e.artifact.hasACs === true);
  const firstFetched = evaluated.find((e) => e.artifact !== null);
  const allFailed = evaluated.every((e) => e.artifact === null);
  return { evaluated, refinedIssues, firstPresent, firstFetched, allFailed };
}

export async function loadRefinementArtifact({ repo, prData, prDraft, prClosed, prMerged }, { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {}) {
  const linkedIssues = resolveLinkedIssuesFromPr(prData);
  if (linkedIssues.length === 0) {
    if (prDraft) {
      const body = typeof prData?.body === "string" ? prData.body : "";
      return resolveNoIssueRefinementArtifact(body);
    }
    return {
      status: "unknown",
      linkedIssue: null,
      linkedIssues: [],
      reason: "No deterministically resolvable linked issue (no closingIssuesReferences and no Closes/Fixes/Resolves #n reference in body).",
    };
  }
  const scopeLabel = linkedIssues.map((n) => `#${n}`).join(", ");
  const isUmbrella = linkedIssues.length > 1;
  if (!prDraft && !prClosed && !prMerged) {
    // Ready PR: the refinement ENFORCEMENT (missing_refinement_artifact) is a
    // draft-gate boundary, so the status stays "unknown" and no finding is
    // recorded. But the linked issue's AC data is also the spec-of-record for
    // the pre_approval_gate unticked-AC check (ACCEPT-CRITERIA-VERIFY-AND-
    // REFLECT, #1621), so fetch the linked issue bodies and surface
    // acItems/uncheckedAcItems alongside the unknown status — the
    // pre_approval_gate refuses a `clean` verdict while unticked AC items
    // remain, reading exactly this field. `_onlyEnforcedWhenDraft: false`
    // keeps the draft-gate missing-enforcement off for ready PRs.
    const { evaluated, refinedIssues, firstPresent, firstFetched, allFailed } =
      await evaluateLinkedIssueArtifacts(linkedIssues, { repo, env, ghCommand, runChild });
    const base = {
      status: "unknown",
      linkedIssue: linkedIssues.length === 1 ? linkedIssues[0] : null,
      linkedIssues,
      specSource: REFINEMENT_ARTIFACT_SPEC_SOURCE.LINKED_ISSUE,
      refinedIssues,
      _onlyEnforcedWhenDraft: false,
    };
    if (allFailed) {
      return {
        ...base,
        reason: `Linked issue(s) ${scopeLabel} detected (${linkedIssues.length}); refinement enforcement is a draft-gate boundary and the PR is not draft. Failed to fetch issue bodies, so the spec-of-record AC data is unavailable.`,
      };
    }
    const a = (firstPresent ?? firstFetched).artifact;
    // Union the spec-of-record AC data across EVERY successfully-fetched linked
    // issue, not just the first present one: an umbrella PR closing several
    // refined issues must refuse a clean pre_approval_gate while ANY sibling
    // issue still has an unticked AC (ACCEPT-CRITERIA-VERIFY-AND-REFLECT, #1621).
    // Reporting only the first-present issue's uncheckedAcItems would let a PR
    // whose first-linked issue is fully ticked pass clean while a later sibling
    // still has open ACs. The first-present artifact still anchors the single-
    // value fields (source/sections/linkedDoc/reason) for shape parity with the
    // draft branch.
    const fetchedArtifacts = evaluated
      .filter((e) => e.artifact !== null)
      .map((e) => e.artifact);
    // Dedupe by text (an AC repeating across sibling issues is the same AC) so an
    // umbrella PR with two issues sharing an AC wording does not double-count.
    const dedupe = (arr) => [...new Set(arr)];
    const unionUnchecked = dedupe(fetchedArtifacts.flatMap((x) => x.uncheckedAcItems ?? []));
    const unionAc = dedupe(fetchedArtifacts.flatMap((x) => x.acItems ?? []));
    const unionDod = dedupe(fetchedArtifacts.flatMap((x) => x.dodItems ?? []));
    return {
      ...base,
      linkedIssue: (firstPresent ?? firstFetched).issue,
      source: a.source,
      acItems: unionAc.length > 0 ? unionAc : a.acItems,
      uncheckedAcItems: unionUnchecked,
      dodItems: unionDod.length > 0 ? unionDod : a.dodItems,
      sections: a.sections,
      linkedDoc: a.linkedDoc,
      reason: `Linked issue(s) ${scopeLabel} detected (${linkedIssues.length}); refinement enforcement is a draft-gate boundary and the PR is not draft, so the check is informational only. The spec-of-record AC data is fetched for the pre_approval_gate unticked-AC precondition (#1621).`,
      finding: null,
    };
  }
  const { evaluated, refinedIssues, firstPresent, firstFetched, allFailed } =
    await evaluateLinkedIssueArtifacts(linkedIssues, { repo, env, ghCommand, runChild });

  if (firstPresent) {
    const a = firstPresent.artifact;
    return {
      status: "present",
      linkedIssue: firstPresent.issue,
      linkedIssues,
      specSource: REFINEMENT_ARTIFACT_SPEC_SOURCE.LINKED_ISSUE,
      refinedIssues,
      source: a.source,
      acItems: a.acItems,
      uncheckedAcItems: a.uncheckedAcItems ?? [],
      dodItems: a.dodItems,
      sections: a.sections,
      linkedDoc: a.linkedDoc,
      reason: isUmbrella
        ? `Refinement artifact present via linked issue #${firstPresent.issue} (umbrella PR closes ${scopeLabel}).`
        : a.reason,
      finding: a.finding,
      _onlyEnforcedWhenDraft: prDraft === true,
    };
  }

  // None of the linked issues carry a refinement artifact (or all bodies failed
  // to fetch). Report against the first linked issue for single-value consumers.
  // Note: `finding`/`missing` here is only enforced by the gate when the PR is
  // draft (`_onlyEnforcedWhenDraft`); closed/merged PRs surface it informationally.
  const firstEvaluated = evaluated[0];
  if (allFailed) {
    // Preserve prior single-issue semantics: draft → missing, else unknown.
    if (prDraft) {
      return {
        status: "missing",
        linkedIssue: firstEvaluated.issue,
        linkedIssues,
        specSource: REFINEMENT_ARTIFACT_SPEC_SOURCE.LINKED_ISSUE,
        refinedIssues,
        reason: `Failed to fetch body for linked issue(s) ${scopeLabel}; draft gate cannot verify a refinement artifact, treating as missing.`,
        finding: "missing_refinement_artifact",
      };
    }
    return {
      status: "unknown",
      linkedIssue: linkedIssues.length === 1 ? linkedIssues[0] : firstEvaluated.issue,
      linkedIssues,
      refinedIssues,
      reason: `Failed to fetch body for linked issue(s) ${scopeLabel}; refinement status is unknown.`,
    };
  }
  // Mixed branch: not allFailed, so at least one body fetched but none is
  // refined. Report against the first successfully-fetched (non-null) issue —
  // `evaluated[0]` may be a failed fetch: it still retains its `issue` field but
  // has `artifact: null` (body fetch / artifact detection failed for that issue).
  const first = firstFetched.artifact;
  return {
    status: "missing",
    linkedIssue: firstFetched.issue,
    linkedIssues,
    specSource: REFINEMENT_ARTIFACT_SPEC_SOURCE.LINKED_ISSUE,
    refinedIssues,
    source: first.source,
    acItems: first.acItems,
    uncheckedAcItems: first.uncheckedAcItems ?? [],
    dodItems: first.dodItems,
    sections: first.sections,
    linkedDoc: first.linkedDoc,
    reason: isUmbrella
      ? `No linked issue (${scopeLabel}) carries a refinement artifact (ACs/DoD); draft gate cannot verify a refinement artifact.`
      : first.reason,
    finding: "missing_refinement_artifact",
    _onlyEnforcedWhenDraft: prDraft === true,
  };
}
async function fetchLocalConflictFiles({ env = process.env, gitCommand = "git", runChild = defaultRunChild } = {}) {
  let result;
  try {
    result = await runChild(
      gitCommand,
      ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "--untracked-files=no"],
      env,
    );
  } catch {
    return [];
  }
  if (result.code !== 0) {
    return [];
  }
  return parseGitStatusConflictFiles(result.stdout);
}
// Operator-authorized post-convergence suppression (#1441): a prior EXPLICIT
// run of withdraw-copilot-review-request.mjs recorded a marker, scoped to an
// exact head, after withdrawing a stranded request on a head that has advanced
// past Copilot's last submitted review with a provable pure doc/prose delta
// since then. Never derived from live snapshot facts alone — the marker only
// exists because a human ran that withdrawal — and re-verified live here
// (rather than trusting the marker's stored reason) as defense in depth. Any
// further push changes the current head, the marker no longer matches, and
// this resolves to false — the normal round-reopening behavior applies exactly
// as before.
export async function resolvePostConvergenceReviewSuppressed({ repo, pr, currentHeadSha, snapshot, prData }, runtime = {}) {
  if (snapshot.copilotReviewRequestStatus !== "none" || snapshot.unresolvedThreadCount !== 0) {
    return false;
  }
  const marker = await readSuppressionMarker({ repo, pr, headSha: currentHeadSha }, runtime);
  if (!marker || marker.headSha !== currentHeadSha) {
    return false;
  }
  // Re-derive the compare BASE live too, not just the classification below —
  // defense in depth against a stale or hand-edited marker whose
  // lastReviewedHeadSha no longer names Copilot's actual last submitted
  // review. A marker that disagrees with the live value must not suppress.
  const liveLastReviewedHeadSha = getLastCopilotReviewHeadSha(prData);
  if (!liveLastReviewedHeadSha || liveLastReviewedHeadSha !== marker.lastReviewedHeadSha) {
    return false;
  }
  const reverified = await classifyDeltaSinceLastReview(
    { repo, base: marker.lastReviewedHeadSha, head: currentHeadSha },
    runtime,
  );
  return reverified.carryForward === true;
}
export async function loadPrGateCoordinationContext(options, runtime = {}) {
  const prData = await fetchPrFactsWithSettledMergeable(options, runtime);
  const currentHeadSha = typeof prData?.headRefOid === "string" && prData.headRefOid.trim().length > 0
    ? prData.headRefOid.trim()
    : null;
  if (!currentHeadSha) {
    throw new Error("Invalid gh pr view payload: missing headRefOid");
  }
  // Fetch Copilot requested-reviewers at the original position (before threads/graphql)
  // to preserve the gh call order existing tests expect; the reconciliation (timeline
  // fetch) is deferred to after reviewSummary is computed (#1588).
  const copilotRequested = await fetchCopilotRequested(options, runtime);
  const threadsPayload = await fetchGithubReviewThreadsPayload(options, runtime);
  const parsedThreads = parseReviewThreads(threadsPayload);
  const gateEvidence = await detectCheckpointEvidence(options, runtime);
  // When draft gate was re-passed on a different head, use its timestamp
  // to reset the Copilot round count — only reviews after the re-pass count.
  // Shared with request-copilot-review so both scripts compute the same
  // completed round count / cap (#896). Prefix matching for the head SHA lets
  // shortened SHAs (7+) from gate comments match the full headRefOid.
  const draftGateResetAtMs = resolveDraftGateRoundResetMs({
    draftGate: gateEvidence.draftGate,
    currentHeadSha,
  });
  const reviewSummary = summarizeCopilotReviews(prData?.reviews, { headSha: currentHeadSha, draftGateResetAtMs });
  const reviewRequestStatus = await resolveCopilotReviewRequestStatus(
    { repo: options.repo, pr: options.pr, reviewSummary, copilotRequested },
    runtime,
  );
  const snapshot = buildSnapshotFromPrFacts({
    prData,
    prNumber: options.pr,
    copilotReviewRequestStatus: reviewRequestStatus,
    copilotReviewPresent: reviewSummary.copilotReviewPresent,
    copilotReviewOnCurrentHead: reviewSummary.hasSubmittedReviewOnCurrentHead,
    unresolvedThreadCount: parsedThreads.summary.unresolvedThreads,
    actionableThreadCount: parsedThreads.summary.actionableThreads,
    copilotReviewRoundCount: reviewSummary.completedCopilotReviewRounds,
  });
  if (snapshot.unresolvedThreadCount > 0
      && !snapshot.copilotReviewOnCurrentHead
      && snapshot.copilotReviewPresent) {
    snapshot.agentFixStatus = "applied";
  }
  const conflictFiles = await fetchLocalConflictFiles(runtime);
  if (gateEvidence.currentHeadSha !== currentHeadSha) {
    throw new Error(`PR head changed while loading gate coordination facts for ${options.repo}#${options.pr}; refuse to evaluate mixed-head gate state.`);
  }
  // Resolve the refinement config (round cap, low-signal heuristic) and feed it to
  // the interpreter. Without it, the interpreter cannot see maxCopilotRounds and so
  // never resolves ROUND_CAP_CLEAN_FALLBACK — a post-cap clean head would fall to
  // READY_TO_REREQUEST_REVIEW, dead-ending the loop at the round cap (#896). This
  // keeps the gate-coordination interpretation consistent with the standalone
  // detect-copilot-loop-state path and with request-copilot-review's cap logic.
  const interpreterRepoRoot = runtime.repoRoot ?? resolveRepoRoot(process.cwd());
  const interpreterConfigResult = await loadDevLoopConfig({ repoRoot: interpreterRepoRoot });
  const interpreterConfigHasErrors = Array.isArray(interpreterConfigResult.errors) && interpreterConfigResult.errors.length > 0;
  // preApprovalRequireCi (#1337) is resolved centrally inside resolveRefinement,
  // so the interpreter honors gates.preApproval.requireCi:false here (shared by
  // detect and upsert via this context builder) without a separate threading step.
  const interpreterRefinementConfig = interpreterConfigHasErrors
    ? resolveRefinement({ version: 1 })
    : resolveRefinement(interpreterConfigResult.config ?? { version: 1 });
  if (options.lightweight) {
    // Compose (not replace) the round cap for light-dispatched PRs (#1210):
    // min(lightMode.maxCopilotRounds ?? 1, refinement.maxCopilotRounds), so
    // maxCopilotRounds: 0 still disables Copilot rounds everywhere. Shared with
    // the maxCopilotRounds resolution below (#1126 requires the two to agree).
    interpreterRefinementConfig.maxCopilotRounds = resolveEffectiveCopilotRoundCap(
      interpreterConfigHasErrors ? { version: 1 } : (interpreterConfigResult.config ?? { version: 1 }),
      { lightweight: true },
    );
  }
  const interpretation = interpretLoopState(snapshot, interpreterRefinementConfig);
  const disposition = summarizeLoopInterpretation(interpretation, interpreterRefinementConfig);
  const mergeStateStatus = typeof prData?.mergeStateStatus === "string" && prData.mergeStateStatus.trim().length > 0
    ? prData.mergeStateStatus.trim().toUpperCase()
    : null;
  const mergeable = typeof prData?.mergeable === "string" && prData.mergeable.trim().length > 0
    ? prData.mergeable.trim().toUpperCase()
    : null;
  const isDraft = Boolean(prData?.isDraft);
  const isClosed = String(prData?.state || "").toUpperCase() === "CLOSED";
  const isMerged = String(prData?.state || "").toUpperCase() === "MERGED";
  const refinementArtifact = await loadRefinementArtifact(
    { repo: options.repo, prData, prDraft: isDraft, prClosed: isClosed, prMerged: isMerged },
    runtime,
  );
  const postConvergenceReviewSuppressed = await resolvePostConvergenceReviewSuppressed(
    { repo: options.repo, pr: options.pr, currentHeadSha, snapshot, prData },
    runtime,
  );
  return {
    repo: options.repo,
    pr: options.pr,
    currentHeadSha,
    mergeStateStatus,
    mergeable,
    conflictFiles,
    prData,
    snapshot,
    gateEvidence,
    interpretation,
    disposition,
    refinementArtifact,
    refinementConfig: interpreterRefinementConfig,
    postConvergenceReviewSuppressed,
  };
}

// #1472: composes the formal-request guard's round-cap exemption from both
// shapes that must suppress it — the interpreter's own roundCapCleanEligible
// (round_cap_clean_fallback) and the evaluator's independent ROUND_CAP_REACHED
// grant (isRoundCapReachedCleanGrant, imported from packages/core, the same
// predicate the core-side applyUnsettledCopilotReviewEntryGuard mirror uses).
// Exported so a test can exercise this exact composition instead of
// re-implementing it.
export function resolveRoundCapCleanFallback({ roundCapCleanEligible, evaluatorResult }) {
  return roundCapCleanEligible === true || isRoundCapReachedCleanGrant(evaluatorResult);
}

async function fetchCopilotEverFormallyRequested({ repo, pr }, { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {}) {
  const result = await runChild(
    ghCommand,
    ["api", `repos/${repo}/issues/${pr}/timeline`, "--paginate", "--jq",
      '.[] | select(.event == "review_requested") | select(.requested_reviewer.login != null) | .requested_reviewer.login'],
    env,
  );
  if (result.code !== 0) return false;
  for (const line of result.stdout.trim().split("\n")) {
    const login = line.trim();
    if (login && isCopilotLogin(login)) return true;
  }
  return false;
}

// #1472: builds the exact input object passed to evaluatePrGateCoordination.
// Exported (and used by detectPrGateCoordinationState below, not duplicated)
// so a test can assert the real production wiring — e.g. that
// unresolvedThreadCount is threaded from context.snapshot rather than a test
// re-implementing this object literal.
export function buildGateCoordinationEvaluatorInput({
  context,
  maxCopilotRounds,
  draftGateConfig,
  preApprovalGateConfig,
  postConvergenceSignificantChange,
}) {
  return {
    repo: context.repo,
    pr: context.pr,
    currentHeadSha: context.currentHeadSha,
    prDraft: Boolean(context.prData?.isDraft),
    prClosed: String(context.prData?.state || "").toUpperCase() === "CLOSED",
    prMerged: String(context.prData?.state || "").toUpperCase() === "MERGED",
    prTitle: context.prData?.title,
    mergeStateStatus: context.mergeStateStatus,
    mergeable: context.mergeable,
    conflictFiles: context.conflictFiles,
    // UI e2e auto-scoping (#976): path-triggered + fail-closed precondition.
    changedFiles: extractChangedFiles(context.prData),
    uiE2ePassed: deriveUiE2ePassed(context.prData),
    lifecycleState: context.interpretation.state,
    loopDisposition: context.disposition.loopDisposition,
    ciStatus: context.snapshot?.ciStatus ?? null,
    copilotReviewRoundCount: context.snapshot?.copilotReviewRoundCount ?? 0,
    maxCopilotRounds,
    // #1472: lets the evaluator's ROUND_CAP_REACHED handling independently
    // confirm "zero unresolved threads" (the exhaustion note's own promise)
    // rather than trusting a stale/compound lifecycleState label alone.
    unresolvedThreadCount: context.snapshot?.unresolvedThreadCount ?? null,
    sameHeadCleanConverged: context.interpretation.sameHeadCleanConverged,
    // Operator-authorized post-convergence suppression (#1441): see
    // resolvePostConvergenceReviewSuppressed above for how this is verified.
    postConvergenceReviewSuppressed: context.postConvergenceReviewSuppressed === true,
    // Independent gate-ENTRY re-check (#1190): fed alongside (not derived from)
    // sameHeadCleanConverged, so an outstanding request on the current head refuses
    // RUN_PRE_APPROVAL_GATE even if sameHeadCleanConverged were somehow stale/wrong.
    copilotReviewRequestStatus: context.snapshot?.copilotReviewRequestStatus ?? "none",
    draftGateRequireCi: draftGateConfig.requireCi,
    preApprovalRequireCi: preApprovalGateConfig.requireCi,
    draftGate: context.gateEvidence.draftGate,
    draftGateMarker: context.gateEvidence.draftGateMarker,
    preApprovalGate: context.gateEvidence.preApprovalGate,
    preApprovalGateMarker: context.gateEvidence.preApprovalGateMarker,
    refinementArtifact: context.refinementArtifact,
    postConvergenceSignificantChange,
  };
}

export async function detectPrGateCoordinationState(options, runtime = {}) {
  const context = await loadPrGateCoordinationContext(options, runtime);
  const repoRoot = runtime.repoRoot ?? resolveRepoRoot(process.cwd());
  const configLoadResult = await loadDevLoopConfig({ repoRoot });
  const hasConfigErrors = Array.isArray(configLoadResult.errors) && configLoadResult.errors.length > 0;
  const config = hasConfigErrors ? {} : (configLoadResult.config ?? {});
  const draftGateConfig = resolveGateConfig(config, "draft");
  const preApprovalGateConfig = resolveGateConfig(config, "preApproval");
  // Shared with interpreterRefinementConfig.maxCopilotRounds in
  // loadPrGateCoordinationContext (#1126: the two must never disagree at the
  // cap boundary) — the same lightweight composition (#1210) is applied here.
  const maxCopilotRounds = options.lightweight
    ? resolveEffectiveCopilotRoundCap(config, { lightweight: true })
    : resolveRefinementConfig(config, "maxCopilotRounds");
  // Shared with interpretLoopState (consumed by copilot-pr-handoff.mjs) and
  // evaluatePrGateCoordination — the single source of truth for "is the
  // Copilot round cap reached" so this detector cannot disagree with the
  // handoff at the cap boundary (#1126).
  const roundCapReached = isCopilotRoundCapReached({
    copilotReviewRoundCount: context.snapshot?.copilotReviewRoundCount,
    maxCopilotRounds,
  });
  const postConvergenceSignificantChange = await detectPostConvergenceSignificantChange(
    {
      repo: context.repo,
      pr: context.pr,
      currentHeadSha: context.currentHeadSha,
      reviews: context.prData?.reviews,
      changedFiles: context.prData?.files,
      roundCapReached: roundCapReached && context.interpretation?.roundCapCleanEligible === true,
      regularCopilotRounds: (context.snapshot?.copilotReviewRoundCount ?? 0) > 0,
    },
    runtime,
  );
  const result = evaluatePrGateCoordination(buildGateCoordinationEvaluatorInput({
    context,
    maxCopilotRounds,
    draftGateConfig,
    preApprovalGateConfig,
    postConvergenceSignificantChange,
  }));
  // Copilot review request guard (#613): When Copilot has reviewed the PR
  // but no formal review request was made, block pre-approval gate entry.
  // Only query timeline when cheap preconditions pass — avoids unnecessary
  // API call when guard cannot possibly trigger.
  const copilotReviewRequestStatus = context.snapshot?.copilotReviewRequestStatus ?? "none";
  const guardBoundaries = new Set([
    PR_CHECKPOINT.PRE_APPROVAL_GATE_NEEDED,
    PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW,
    PR_CHECKPOINT.FINAL_APPROVAL_READY,
  ]);
  const sameHeadCleanConverged = context.interpretation?.sameHeadCleanConverged ?? false;
  // Round-cap clean fallback (#896): the interpreter resolved a clean post-cap head
  // (zero unresolved threads + green CI) that Copilot will not re-review. The formal
  // request guard must not fire here — pre_approval_gate reviews the post-cap head.
  //
  // #1472: without this, the guard below would rewrite the evaluator's
  // ROUND_CAP_REACHED grant (see isRoundCapReachedCleanGrant) to
  // request_copilot_review whenever Copilot was never formally requested,
  // re-blocking the exact fallback the grant just opened. Widen the exemption
  // to cover that shape too — it is the same "no further Copilot round is
  // legal" fact pattern roundCapCleanEligible already exempts.
  const roundCapCleanFallback = resolveRoundCapCleanFallback({
    roundCapCleanEligible: context.interpretation?.roundCapCleanEligible ?? false,
    evaluatorResult: result,
  });
  const copilotReviewEverFormallyRequested = copilotReviewRequestStatus === "none"
    && guardBoundaries.has(result.gateBoundary)
    // cap-0 disables the Copilot gate, so shouldGuardCopilotReviewRequest always
    // returns false here — skip the timeline fetch it would never need (#1126).
    // (Restores the suppression the roundCapReached predicate swap dropped.)
    && maxCopilotRounds !== 0
    && !(roundCapReached
      && (sameHeadCleanConverged || roundCapCleanFallback)
      && !postConvergenceSignificantChange)
    ? await fetchCopilotEverFormallyRequested(
        { repo: context.repo, pr: context.pr },
        runtime,
      )
    : false;
  if (shouldGuardCopilotReviewRequest({
    copilotReviewRequestStatus,
    copilotReviewRoundCount: context.snapshot?.copilotReviewRoundCount ?? 0,
    copilotReviewEverFormallyRequested,
    maxCopilotRounds,
    sameHeadCleanConverged,
    roundCapCleanFallback,
    postConvergenceSignificantChange,
    gateBoundary: result.gateBoundary,
  })) {
    result.gateBoundary = PR_CHECKPOINT.POST_DRAFT_EXTERNAL_REVIEW;
    result.nextAction = PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW;
    result.reason = "No formal Copilot review request found — run request-copilot-review.mjs first.";
    result.allowedNextActions = [PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW];
    result.forbiddenActions = [
      PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
      PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW,
      PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE,
      PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL,
      PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
    ];
  }

  const preApprovalNeverEntered = !(result.preApprovalGate?.contractComplete === true);
  const gateBoundariesExpectingPreApproval = new Set([
    PR_CHECKPOINT.PRE_APPROVAL_GATE_NEEDED,
    PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW,
    PR_CHECKPOINT.FINAL_APPROVAL_READY,
  ]);
  if (preApprovalNeverEntered && gateBoundariesExpectingPreApproval.has(result.gateBoundary)) {
    result.gateBoundary = PR_CHECKPOINT.PRE_APPROVAL_GATE_NEEDED;
    result.nextAction = PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE;
    result.reason = "No contract-complete pre_approval_gate marker exists for the current head SHA; run pre_approval_gate before proceeding.";
    result.allowedNextActions = [PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE];
  }
  const draftGateEvidenceMissing = !(result.draftGate?.cleanEvidenceExists);
  const gateBoundariesExpectingDraftGate = new Set([
    PR_CHECKPOINT.POST_DRAFT_EXTERNAL_REVIEW,
    PR_CHECKPOINT.FEEDBACK_RESOLUTION,
    PR_CHECKPOINT.PRE_APPROVAL_GATE_NEEDED,
    PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW,
    PR_CHECKPOINT.FINAL_APPROVAL_READY,
  ]);
  if (draftGateEvidenceMissing && gateBoundariesExpectingDraftGate.has(result.gateBoundary)) {
    result.gateBoundary = PR_CHECKPOINT.DRAFT_GATE_NEEDED;
    result.nextAction = PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE;
    result.reason = result.draftGate?.anyVisible
      ? "Clean draft_gate evidence is required before merge (no gate exemptions, #579). A draft_gate comment exists but is not clean; convert the PR back to draft before re-running draft_gate, or clear the existing evidence before running reconcile_draft_gate."
      : "Clean draft_gate evidence is required before merge (no gate exemptions, #579). No visible clean draft_gate comment exists for this PR; run reconcile_draft_gate before proceeding.";
    result.allowedNextActions = [PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE];
    result.forbiddenActions = [
      PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
      PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW,
      PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW,
      PR_CHECKPOINT_ACTION.WAIT_FOR_COPILOT_REVIEW,
      PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE,
      PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL,
      PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
    ];
    result.gateEvidenceNote = null;
  }
  // Expose effective round count in output for testability (#560)
  result.copilotReviewRoundCount = context.snapshot?.copilotReviewRoundCount ?? 0;
  // Auto-release the runner-coordination lock at terminal stop boundaries (#1632):
  // a dev-loop run that completes (merge-ready / done) or stops (approval checkpoint /
  // blocked) releases its claim immediately so a fresh re-dispatch acquires the lock
  // without a takeover, instead of relying on the 30-min TTL. The 30-min TTL remains
  // the fallback when a run crashes before reaching here. Best-effort and env-aware
  // (no-op without DEVLOOPS_RUN_ID); never blocks the detector and never clears a
  // claim owned by a genuinely active competing run (fail-closed competitor preserved).
  if (TERMINAL_RUNNER_RELEASE_ACTIONS.has(result.nextAction)) {
    const releaseImpl = runtime.releaseAsyncRunnerOwnershipImpl ?? releaseAsyncRunnerOwnership;
    try {
      await releaseImpl({
        repo: options.repo,
        pr: options.pr,
        env: runtime.env ?? process.env,
        cwd: repoRoot,
      });
    } catch {
      // Best-effort: a release failure must never block gate-coordination detection.
    }
  }
  return result;
}
async function main() {
  let options;
  try {
    options = parseDetectPrGateCoordinationCliArgs(process.argv.slice(2));
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
    const result = await detectPrGateCoordinationState(options);
    process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent });
  } catch (error) {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  }
}
if (isDirectCliRun(import.meta.url)) {
  await main();
}
