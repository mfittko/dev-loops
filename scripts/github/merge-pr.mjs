#!/usr/bin/env node
import { parseArgs } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildParseError, formatCliError, isCopilotLogin, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { ghJson as defaultGhJson } from "@dev-loops/core/github/gh";
import { loadDevLoopConfig, resolveEffectiveCopilotRoundCap, resolveEffectiveMergeAuthorizedFromLoad, resolveHumanMergeOnly } from "@dev-loops/core/config";
import { countUnresolvedHumanChangesRequested } from "@dev-loops/core/loop/size-budget-merge-gate";
import { resolveRepoRoot } from "../loop/_repo-root-resolver.mjs";
import {
  evaluateMergePreconditions,
  evaluateCopilotConvergence,
  resolveCiGreenFromRollup,
  isValidGithubLogin,
  COPILOT_CONVERGENCE_STATE,
  COPILOT_ABSENT_REVIEW_DISPOSITION,
} from "@dev-loops/core/loop/merge-approval";
import { summarizeCopilotReviews, resolveDraftGateRoundResetMs } from "@dev-loops/core/github/copilot-helpers";
import { isCopilotReviewObservableViaGraphql } from "./request-copilot-review.mjs";
import { getLastCopilotReviewHeadSha, fetchDeltaChangedFiles, resolveCarriedConvergence } from "../loop/_copilot-convergence-carry.mjs";
import { resolveCurrentHeadBodyFeedback } from "./_copilot-body-disposition.mjs";
import { detectPostConvergenceSignificantChange } from "../loop/_post-convergence-change.mjs";
import { detectInternalOnly } from "../loop/detect-internal-only-pr.mjs";
import { resolveNamedContextState, LOOP_DERIVED_CI_CHECK_NAME } from "@dev-loops/core/loop/copilot-ci-status";
import { assertGithubWriteStubbedInTestMode } from "@dev-loops/core/github/test-mode-write-guard";
import { flattenPaginatedSlurp } from "./post-gate-findings.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const VALID_METHODS = new Set(["squash", "merge", "rebase"]);

// A boolean flag token: bare (`--flag`) is true; an explicit inline value
// (`--flag=false`/`=0`/`=no`) is honored so an explicit disable is never read as
// enabled. `=true`/`=1`/`=yes` (and any other value) resolve true.
function flagValueTrue(token) {
  if (token.value === undefined || token.value === null || token.value === "") return true;
  return !/^(?:false|0|no)$/i.test(String(token.value).trim());
}

const USAGE = `Usage: merge-pr.mjs --repo <owner/name> --pr <number> --human-approved-by <github-login>
                   [--method squash|merge|rebase] [--stable-release] [--lightweight]

Sanctioned dev-loops merge wrapper (issue #1939). Runs the FULL merge-precondition
set fail-closed, then performs the merge. Raw \`gh pr merge\` is forbidden — route
every merge through this wrapper. This wrapper NEVER tags or publishes and NEVER
satisfies the operator-owned stable-release approval gate: it only merges the PR
into its base.

Required:
  --repo <owner/name>          Repository slug
  --pr <number>                Pull request number
  --human-approved-by <login>  The human approver's GitHub login. Validated as a
                               real login (not a boolean or free text). Stamped on
                               the machine-readable result and audit trail.

Optional:
  --method <m>                 Merge method: squash (default) | merge | rebase
  --stable-release             Mark this as a stable-release merge, forcing the
                               escalated approval class (a standing authorization
                               never satisfies it). Does NOT tag or publish.
  --standing-authorization     Assert a recorded standing merge authorization
                               applies (autonomy.humanMergeOnly:false is not, by
                               itself, a standing authorization). Only then can a
                               drain merge proceed without a fresh operator
                               approval; absent this flag, a drain merge also
                               requires a fresh approval. Ignored under
                               humanMergeOnly (the wrapper refuses outright).
  --lightweight                This PR is light-dispatched: resolve the Copilot
                               round cap as the composed cap min(localImplementation.
                               lightMode.maxCopilotRounds ?? 1, refinement.
                               maxCopilotRounds), as the loop does.

Preconditions (each refuses with a machine-readable reason naming the failing one):
  human_approver, mergeable, ci_green, title_markers, gate_evidence,
  copilot_convergence, size_budget_human_approval, merge_approval.
  copilot_convergence refuses a current-head Copilot "Changes recommended" (🟡)
  or unrecognized non-approval disposition (🔵 "Needs a closer look" is
  conductor-overridable; unresolved threads still gate it). A trusted
  copilot-body-disposition record for the current head clears a current-head
  body finding. With no current-head
  Copilot review it passes only via a sanctioned disposition for the current
  head: copilot_gate_disabled (round cap 0, or an internal-only PR),
  round_cap_clean_fallback (round cap reached, unless the last review was clean
  and a significant change landed since), or docs_only_suppression (the loop's
  carried convergence holds across a docs-only or integrate-only delta, and no
  Copilot review is outstanding on the current head). gate_evidence reuses
  detect-checkpoint-evidence (draft_gate + current-head pre_approval_gate with
  fan-out provenance, zero unresolved threads, a non-stale/non-foreign runner lock).

Merge classes:
  drain      normal merge — satisfied by a recorded standing authorization
             (asserted via --standing-authorization, and only when
             autonomy.humanMergeOnly is false) OR a fresh operator approval.
  escalated  size escalate/block, T1-touching, or --stable-release — requires a
             fresh per-merge operator approval; a standing authorization does not
             satisfy it. Fresh approval = a head-pinned APPROVED review by
             <login>, else a head-pinned operator comment "approve merge <headSha>".

Output (stdout, JSON): { ok, merged, mergeCommit, approvedBy, mergeClass, approvalVia, method, repo, pr, headSha, copilotConvergenceState, copilotDisposition, copilotCarriedConvergence, copilotBodyDisposition }
  copilotConvergenceState: current_head_clean | current_head_findings | no_current_head_review,
  or null when the current head SHA is unknown
  copilotDisposition: the current-head review disposition, or for
  no_current_head_review the sanctioned disposition that satisfied it
  copilotCarriedConvergence: for docs_only_suppression, the carried review
  { source, sourceReviewId, sourceHeadSha, bodyDisposition }; else null
  copilotBodyDisposition: the copilot-body-disposition record that cleared a
  current-head body finding; else null
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Merge succeeded
  1  Argument error, gh failure, or a failed precondition
  2  Invalid --jq filter`.trim();

const parseError = buildParseError(USAGE);

export function parseMergePrCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      "human-approved-by": { type: "string" },
      method: { type: "string" },
      "stable-release": { type: "boolean" },
      "standing-authorization": { type: "boolean" },
      lightweight: { type: "boolean" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = { help: false, repo: undefined, pr: undefined, humanApprovedBy: undefined, method: "squash", stableRelease: false, standingAuthorization: false, lightweight: false };
  for (const token of tokens) {
    if (token.kind === "positional") throw parseError(`Unknown argument: ${token.value}`);
    if (token.kind !== "option") continue;
    if (token.name === "help") { options.help = true; return options; }
    if (token.name === "repo") { options.repo = requireTokenValue(token, parseError).trim(); continue; }
    if (token.name === "pr") { options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError); continue; }
    if (token.name === "human-approved-by") { options.humanApprovedBy = requireTokenValue(token, parseError).trim(); continue; }
    if (token.name === "method") { options.method = requireTokenValue(token, parseError).trim().toLowerCase(); continue; }
    // Honor an explicit `=false`/`=0` value so `--stable-release=false` /
    // `--standing-authorization=false` cannot be silently treated as enabled — a
    // presence-means-true parse would fail OPEN on an explicit disable.
    if (token.name === "stable-release") { options.stableRelease = flagValueTrue(token); continue; }
    if (token.name === "standing-authorization") { options.standingAuthorization = flagValueTrue(token); continue; }
    if (token.name === "lightweight") { options.lightweight = flagValueTrue(token); continue; }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.help) return options;
  if (options.repo === undefined || options.pr === undefined) {
    throw parseError("merge-pr requires both --repo <owner/name> and --pr <number>");
  }
  if (options.humanApprovedBy === undefined || options.humanApprovedBy === "") {
    throw parseError("merge-pr requires --human-approved-by <github-login> (fail-closed: a merge cannot proceed without a recorded human approver)");
  }
  if (!isValidGithubLogin(options.humanApprovedBy)) {
    throw parseError(`--human-approved-by must be a real GitHub login, got "${options.humanApprovedBy}"`);
  }
  if (!VALID_METHODS.has(options.method)) {
    throw parseError(`--method must be one of squash|merge|rebase, got "${options.method}"`);
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}

// Default gate-evidence probe: shell the sanctioned detect-checkpoint-evidence
// CLI and read its verdict. It is the single source of truth for draft_gate /
// current-head pre_approval_gate verdicts, unresolved threads, the runner lock,
// and fan-out provenance — reused wholesale (non-goal: do not re-derive the set).
const DETECT_EVIDENCE_PATH = fileURLToPath(new URL("./detect-checkpoint-evidence.mjs", import.meta.url));
function defaultDetectEvidence({ repo, pr, env, cwd }) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [DETECT_EVIDENCE_PATH, "--repo", repo, "--pr", String(pr)],
      { env, cwd, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        let parsed = null;
        try { parsed = JSON.parse(error ? stderr : stdout); } catch { parsed = null; }
        // A zero exit with unparseable output must NOT pass as satisfied evidence:
        // we could no longer read the size-budget outcome (which sets the merge
        // class), so treat it as a gate_evidence failure and fail closed.
        const ok = !error && parsed !== null;
        const size = parsed?.preApprovalGate ?? {};
        const failures = Array.isArray(parsed?.preMergeGateCheck?.failures)
          ? parsed.preMergeGateCheck.failures
          : parsed?.error
            ? [parsed.error]
            : ok
              ? []
              : ["detect-checkpoint-evidence output could not be read"];
        resolve({
          ok,
          sizeOutcome: typeof size.sizeOutcome === "string" ? size.sizeOutcome : null,
          // Preserve a missing/non-boolean T1 signal as null so the size gate
          // fails closed on absent evidence rather than reading it as "untouched".
          touchesT1: typeof size.sizeTouchesT1 === "boolean" ? size.sizeTouchesT1 : null,
          currentHeadSha: typeof parsed?.currentHeadSha === "string" ? parsed.currentHeadSha : null,
          draftGate: parsed?.draftGate ?? null,
          failures,
        });
      },
    );
  });
}

// Resolve the sanctioned disposition that lets a head WITHOUT a current-head
// Copilot review converge, in order: the Copilot gate is disabled (cap 0); the
// round cap is exhausted (round-cap clean fallback); or the loop's shared
// carried-convergence predicate carries the prior Copilot review across a
// docs-only or integrate-only delta (docs-only suppression). Returns
// `{ kind, headSha }` pinned to the current head, plus `carriedConvergence`
// (the source review and its commit) for docs-only suppression, or null
// (copilot_convergence then refuses). Last, an internal-only PR (the loop's
// reviewMode internal_only, which skips the Copilot cycle) maps to
// copilot_gate_disabled.
async function resolveCopilotAbsentReviewDisposition({ repo, pr, currentHeadSha, rawReviews, config, draftGate, lightweight }, runtime) {
  const pinned = (kind) => ({ kind, headSha: currentHeadSha });
  const cap = resolveEffectiveCopilotRoundCap(config ?? { version: 1 }, { lightweight });
  if (cap === 0) return pinned(COPILOT_ABSENT_REVIEW_DISPOSITION.COPILOT_GATE_DISABLED);
  const reviews = toSharedReviewShape(rawReviews);
  const lastReviewedHead = getLastCopilotReviewHeadSha({ reviews });
  const lastReviewConverged = lastReviewedHead !== null && lastReviewedHead !== currentHeadSha
    && evaluateCopilotConvergence({ currentHeadSha: lastReviewedHead, reviews }).state === COPILOT_CONVERGENCE_STATE.CURRENT_HEAD_CLEAN;
  // A missing draftGate means no round reset (the permissive direction); it only occurs when evidence is unreadable, which already fails gate_evidence.
  const { completedCopilotReviewRounds } = summarizeCopilotReviews(reviews, {
    headSha: currentHeadSha,
    draftGateResetAtMs: resolveDraftGateRoundResetMs({ draftGate, currentHeadSha }),
  });
  // ADR 0012: at the cap, a significant change after a converged review opens a
  // new cycle regardless of the spent cap. A fix pushed after a findings review
  // keeps the fallback.
  if (completedCopilotReviewRounds >= cap
    && (!lastReviewConverged || !(await hasSignificantChangeSinceLastReview({ repo, pr, currentHeadSha, reviews }, runtime)))) {
    return pinned(COPILOT_ABSENT_REVIEW_DISPOSITION.ROUND_CAP_CLEAN_FALLBACK);
  }
  // Below the cap, or at the cap after the raw significance probe reopened the
  // cycle: the loop honors a carried convergence in both cases (the raw probe
  // skips the base-relative reduction), so merge consults the same predicate.
  // The request status is checked separately, with merge-side fail-closed reads.
  const carried = await resolveCarriedConvergence({ repo, pr, currentHeadSha, prData: { reviews }, copilotReviewRequestStatus: "none" }, runtime);
  if (carried.carried && !(await isCopilotReviewOutstanding({ repo, pr, currentHeadSha, rawReviews }, runtime))) {
    const { source, sourceReviewId, sourceHeadSha, bodyDisposition } = carried;
    return { ...pinned(COPILOT_ABSENT_REVIEW_DISPOSITION.DOCS_ONLY_SUPPRESSION), carriedConvergence: { source, sourceReviewId, sourceHeadSha, bodyDisposition } };
  }
  return (await isInternalOnlyPr({ repo, pr, patterns: config?.internalPathPatterns }, runtime)) ? pinned(COPILOT_ABSENT_REVIEW_DISPOSITION.COPILOT_GATE_DISABLED) : null;
}

// The shared loop helpers read the GraphQL review shape (`id` is the review's
// node id, the id a copilot-body-disposition record names).
function toSharedReviewShape(rawReviews) {
  return rawReviews.map((r) => ({ ...r, author: { login: r.login }, submittedAt: r.submitted_at }));
}

// The loop's round-cap new-cycle rule, reusing its shared significance helper.
// That helper fails open on an unreadable compare; here an untrusted delta
// counts as significant (fail closed). Trust follows the shared compare
// contract of fetchDeltaChangedFiles (linear "ahead", no rename/copy, below the
// files page cap, a files array whose every entry names a file), replayed
// over the helper's own compare result.
async function hasSignificantChangeSinceLastReview({ repo, pr, currentHeadSha, reviews }, { env, ghCommand, runChild }) {
  let compareReadable = false;
  const probe = async (cmd, args, childEnv) => {
    const result = await runChild(cmd, args, childEnv);
    compareReadable = (await fetchDeltaChangedFiles({ repo, base: "", head: currentHeadSha }, { env, ghCommand, runChild: async () => result })) !== null;
    return result;
  };
  try {
    const significant = await detectPostConvergenceSignificantChange(
      // ponytail: changedFiles only feeds the helper's "PR has files" guard; a PR at merge has files.
      { repo, pr, currentHeadSha, reviews, changedFiles: [currentHeadSha], roundCapReached: true, regularCopilotRounds: true },
      { env, ghCommand, runChild: probe },
    );
    return significant || !compareReadable;
  } catch {
    return true;
  }
}

// A PENDING Copilot review on the current head or a live Copilot review request
// means a review is outstanding. REST goes blind once a request turns into an
// in-progress review, so the GraphQL reviewRequests/review-node probe is also
// consulted. That probe is fail-soft (an error reads as "not observed"); here an
// unobservable GraphQL state or any read failure counts as outstanding.
async function isCopilotReviewOutstanding({ repo, pr, currentHeadSha, rawReviews }, { env, ghCommand, runChild, ghJson }) {
  if (rawReviews.some((r) => isCopilotLogin(r.login) && String(r.state).toUpperCase() === "PENDING" && r.commit_id === currentHeadSha)) return true;
  try {
    const requested = await ghJson(["api", `repos/${repo}/pulls/${pr}/requested_reviewers`], { env, ghCommand, runChild });
    if (!Array.isArray(requested?.users) || requested.users.some((u) => isCopilotLogin(u?.login))) return true;
    let observable = false;
    const probe = async (cmd, args, childEnv) => {
      const result = await runChild(cmd, args, childEnv);
      try {
        const pull = JSON.parse(result.stdout)?.data?.repository?.pullRequest;
        observable = result.code === 0 && Array.isArray(pull?.reviewRequests?.nodes) && Array.isArray(pull?.reviews?.nodes);
      } catch { observable = false; }
      return result;
    };
    const seen = await isCopilotReviewObservableViaGraphql({ repo, pr, headSha: currentHeadSha }, { env, ghCommand, runChild: probe });
    return seen || !observable;
  } catch {
    return true;
  }
}

// Internal-only needs two agreeing verdicts: the detector's own verdict (the
// rule the loop uses to skip Copilot) AND a match against the
// internalPathPatterns of the config merge-pr loaded for its own repo root.
// A disagreement, no patterns, an invalid pattern, no files, or a detection
// error fails closed.
async function isInternalOnlyPr({ repo, pr, patterns }, { env, ghCommand, runChild, detectInternalOnlyPr }) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  try {
    const matchers = patterns.map((p) => new RegExp(p));
    const result = await detectInternalOnlyPr({ repo, pr }, { env, ghCommand, runChild });
    if (result?.ok !== true || result.internalOnly !== true) return false;
    const files = Array.isArray(result.files) ? result.files : [];
    return files.length > 0 && files.every((f) => matchers.some((r) => r.test(f)));
  } catch {
    return false;
  }
}

export async function mergePr(options, runtime = {}) {
  const {
    env = process.env,
    ghCommand = "gh",
    cwd = process.cwd(),
    ghJson = defaultGhJson,
    runChild = defaultRunChild,
    detectEvidence = defaultDetectEvidence,
    loadConfig = loadDevLoopConfig,
    detectInternalOnlyPr = detectInternalOnly,
  } = runtime;

  assertGithubWriteStubbedInTestMode(runChild, "pr merge", { env });

  const prView = await ghJson(
    ["pr", "view", String(options.pr), "--repo", options.repo, "--json", "mergeable,mergeStateStatus,title,headRefOid,url,statusCheckRollup"],
    { env, ghCommand, runChild },
  );
  const currentHeadSha = typeof prView?.headRefOid === "string" && prView.headRefOid.trim().length > 0 ? prView.headRefOid.trim() : null;
  if (!currentHeadSha) throw new Error("Invalid gh pr view payload: missing headRefOid");

  const rawReviews = flattenPaginatedSlurp(await ghJson(
    ["api", "--paginate", "--slurp", `repos/${options.repo}/pulls/${options.pr}/reviews?per_page=100`],
    { env, ghCommand, runChild },
  )).map((r) => ({ id: r?.node_id ?? null, login: r?.user?.login ?? null, state: r?.state ?? null, commit_id: r?.commit_id ?? null, type: r?.user?.type ?? null, body: r?.body ?? "", submitted_at: r?.submitted_at ?? null }));
  const comments = flattenPaginatedSlurp(await ghJson(
    ["api", "--paginate", "--slurp", `repos/${options.repo}/issues/${options.pr}/comments?per_page=100`],
    { env, ghCommand, runChild },
  )).map((c) => ({ login: c?.user?.login ?? null, body: c?.body ?? "", type: c?.user?.type ?? null }));

  const evidence = await detectEvidence({ repo: options.repo, pr: options.pr, env, cwd });
  const configLoad = await loadConfig({ repoRoot: resolveRepoRoot(cwd) });

  // Fail closed on a config load/validation error: an unreadable `.devloops` is
  // the very file that would declare humanMergeOnly and drive fan-out-evidence
  // enforcement, so a fresh approval must not be able to merge past a config we
  // could not verify.
  if (Array.isArray(configLoad?.errors) && configLoad.errors.length > 0) {
    const error = new Error(`merge refused: dev-loop config could not be loaded/validated (${configLoad.errors.length} error(s)) — cannot verify humanMergeOnly or standing authorization`);
    error.mergePrFailure = { ok: false, merged: false, repo: options.repo, pr: options.pr, headSha: currentHeadSha, approvedBy: options.humanApprovedBy, configError: true };
    throw error;
  }

  // Under autonomy.humanMergeOnly, merge is a fixed human-only action: the agent
  // must hand off and NOT run even this wrapper (merge-preconditions.md, the
  // humanMergeOnly section). Fail closed before any precondition/merge work.
  if (resolveHumanMergeOnly(configLoad?.config)) {
    const error = new Error("merge refused: autonomy.humanMergeOnly is set — merge is a human-only action and the agent must hand off, not run the merge wrapper");
    error.mergePrFailure = { ok: false, merged: false, repo: options.repo, pr: options.pr, headSha: currentHeadSha, approvedBy: options.humanApprovedBy, humanMergeOnly: true };
    throw error;
  }

  // A standing authorization is NOT established by config alone
  // (autonomy.humanMergeOnly:false authorizes nothing). The orchestrator asserts
  // a recorded standing authorization exists via --standing-authorization; the
  // config guard then only rejects the humanMergeOnly case (already handled
  // above). Absent the flag, a drain merge requires a fresh operator approval.
  const standingAuthorized = options.standingAuthorization === true && resolveEffectiveMergeAuthorizedFromLoad(true, configLoad);

  // Head race: the gate evidence is read by a separate `gh pr view` inside
  // detect-checkpoint-evidence. If a push landed between our head read and the
  // evidence read, the evidence is for a different head than the approval/title/
  // mergeable facts — fail closed so every head bump re-gates.
  const evidenceHeadMismatch = typeof evidence.currentHeadSha === "string"
    && evidence.currentHeadSha.length > 0
    && evidence.currentHeadSha !== currentHeadSha;

  // Only a head without a current-head Copilot review needs a sanctioned
  // disposition, so the extra config/compare work runs only then.
  const rawConvergenceState = evaluateCopilotConvergence({ currentHeadSha, reviews: rawReviews }).state;
  const copilotAbsentReviewDisposition = rawConvergenceState === COPILOT_CONVERGENCE_STATE.NO_CURRENT_HEAD_REVIEW
    ? await resolveCopilotAbsentReviewDisposition(
      { repo: options.repo, pr: options.pr, currentHeadSha, rawReviews, config: configLoad?.config, draftGate: evidence.draftGate, lightweight: options.lightweight === true },
      { env, ghCommand, runChild, ghJson, detectInternalOnlyPr },
    )
    : null;
  // A current-head body finding clears through the same trusted
  // copilot-body-disposition record the loop and gate entry honor.
  const copilotBodyDisposition = rawConvergenceState === COPILOT_CONVERGENCE_STATE.CURRENT_HEAD_FINDINGS
    ? (await resolveCurrentHeadBodyFeedback({
      repo: options.repo,
      pr: options.pr,
      headSha: currentHeadSha,
      reviewSummary: summarizeCopilotReviews(toSharedReviewShape(rawReviews), {
        headSha: currentHeadSha,
        draftGateResetAtMs: resolveDraftGateRoundResetMs({ draftGate: evidence.draftGate, currentHeadSha }),
      }),
    }, { env, ghCommand, runChild })).bodyDisposition
    : null;

  const verdict = evaluateMergePreconditions({
    humanApprovedBy: options.humanApprovedBy,
    mergeable: typeof prView?.mergeable === "string" ? prView.mergeable : null,
    mergeStateStatus: typeof prView?.mergeStateStatus === "string" ? prView.mergeStateStatus : null,
    ciGreen: resolveCiGreenFromRollup(prView?.statusCheckRollup),
    title: typeof prView?.title === "string" ? prView.title : null,
    gateEvidence: {
      ok: evidence.ok === true && !evidenceHeadMismatch,
      failures: evidenceHeadMismatch
        ? [...(evidence.failures ?? []), `gate evidence head ${evidence.currentHeadSha} does not match the current head ${currentHeadSha} (a push landed mid-check); re-run at the current head`]
        : evidence.failures,
    },
    sizeOutcome: evidence.sizeOutcome,
    touchesT1: evidence.touchesT1,
    unresolvedChangesRequestedCount: countUnresolvedHumanChangesRequested(rawReviews),
    currentHeadSha,
    reviews: rawReviews,
    comments,
    standingAuthorized,
    stableRelease: options.stableRelease === true,
    copilotAbsentReviewDisposition,
    copilotBodyDisposition,
  });

  if (!verdict.ok) {
    // A light-dispatched PR merged without --lightweight resolves the full cap and
    // can refuse where the composed cap would grant the round-cap fallback. Name
    // the remedy in the refusal itself.
    const capConfig = configLoad?.config ?? { version: 1 };
    const lightweightRemedy = verdict.copilotConvergenceState === COPILOT_CONVERGENCE_STATE.NO_CURRENT_HEAD_REVIEW
      && options.lightweight !== true
      && resolveEffectiveCopilotRoundCap(capConfig, { lightweight: true }) < resolveEffectiveCopilotRoundCap(capConfig);
    const failures = lightweightRemedy
      ? verdict.failures.map((f) => (f.precondition === "copilot_convergence"
        ? { ...f, reason: `${f.reason}. If this PR was light-dispatched (and only then), re-run merge-pr with --lightweight so the composed lightweight round cap applies` }
        : f))
      : verdict.failures;
    const error = new Error(`Merge preconditions not satisfied: ${failures.map((f) => `${f.precondition} (${f.reason})`).join("; ")}`);
    error.mergePrFailure = {
      ok: false,
      merged: false,
      repo: options.repo,
      pr: options.pr,
      headSha: currentHeadSha,
      approvedBy: options.humanApprovedBy,
      mergeClass: verdict.mergeClass,
      failures,
      copilotConvergenceState: verdict.copilotConvergenceState,
      copilotDisposition: verdict.copilotDisposition,
      copilotCarriedConvergence: copilotAbsentReviewDisposition?.carriedConvergence ?? null,
      copilotBodyDisposition: verdict.copilotBodyDisposition,
    };
    throw error;
  }

  // All preconditions satisfied — perform the merge. NEVER a tag or publish.
  // runChild resolves for ANY exit code (it only rejects on a spawn error), so a
  // `gh pr merge` that exits non-zero (a branch-protection block, a precondition
  // that shifted between check and merge, a transient conflict) must be caught
  // explicitly — otherwise the wrapper would report ok/exit-0 for a merge that
  // never happened.
  // `--match-head-commit <sha>` pins the mutation to the exact head every
  // precondition was checked against: a push between the reads and this command
  // makes `gh pr merge` fail closed instead of merging an unchecked newer head.
  // `env` is runChild's THIRD POSITIONAL arg (not an options object) — passing
  // `{ env }` would replace the child env with `{ env: ... }`, stripping
  // GH_TOKEN/PATH so `gh` could not run.
  const mergeRun = await runChild(
    ghCommand,
    ["pr", "merge", String(options.pr), "--repo", options.repo, `--${options.method}`, "--match-head-commit", currentHeadSha],
    env,
  );
  // Anything but an explicit code 0 fails closed: a non-zero exit AND a
  // signal-kill (runChild resolves `{ code: null }`) both mean the merge did
  // not cleanly succeed, so neither may report ok/exit-0.
  if (!mergeRun || mergeRun.code !== 0) {
    const rawStderr = (mergeRun?.stderr || "").trim() || "no stderr";
    // The observed real-world path (docs/decisions/0076): every real
    // precondition (including
    // `ciGreen`, which already EXCLUDES `gate-evidence` — see
    // resolveCiGreenFromRollup) passed, so `gh pr merge` is the first place a
    // stale/non-success `gate-evidence` REQUIRED context surfaces, and GitHub's
    // own stderr for that block is the generic "base branch policy prohibits
    // the merge" — it never names the actual required check. Name it here.
    //
    // Only attach the note when `rawStderr` actually LOOKS LIKE a
    // branch-protection/base-branch-policy block (AC3 real-cause
    // requirement): a signal-kill
    // (`code: null`), a `--match-head-commit` head-race, or a transient
    // gh/API error would otherwise get this misleading "needs a COMPLETED
    // Gate-evidence run" note even though the real failure is unrelated.
    const looksLikeBranchPolicyBlock = /base branch policy|protected branch|required status check/i.test(rawStderr);
    const gateEvidenceState = resolveNamedContextState(prView?.statusCheckRollup, LOOP_DERIVED_CI_CHECK_NAME);
    const gateEvidenceNote = looksLikeBranchPolicyBlock && gateEvidenceState !== "success"
      ? ` The required \`${LOOP_DERIVED_CI_CHECK_NAME}\` context is ${gateEvidenceState} at head ${currentHeadSha}; this required check needs a COMPLETED Gate-evidence run. Recovery: complete/re-run the latest Gate-evidence Actions run to success, or edit the current-head gate-verdict comment to re-fire it (see ADR 0043 / the reporter split in ADR 0076).`
      : "";
    throw new Error(`gh pr merge did not succeed (code ${mergeRun?.code ?? "null"}): ${rawStderr}${gateEvidenceNote}`);
  }
  const merged = await ghJson(
    ["pr", "view", String(options.pr), "--repo", options.repo, "--json", "mergeCommit,state"],
    { env, ghCommand, runChild },
  );
  // Postcondition: a `gh pr merge` that exits 0 but whose state is not MERGED
  // (e.g. auto-merge queued, or a race) is NOT a completed merge — never report
  // it as a success.
  if (String(merged?.state ?? "").toUpperCase() !== "MERGED") {
    throw new Error(`gh pr merge exited 0 but PR #${options.pr} is not MERGED (state=${merged?.state ?? "unknown"}); refusing to report a false success`);
  }

  return {
    ok: true,
    merged: true,
    mergeCommit: typeof merged?.mergeCommit?.oid === "string" ? merged.mergeCommit.oid : null,
    approvedBy: options.humanApprovedBy,
    mergeClass: verdict.mergeClass,
    approvalVia: verdict.approvalVia,
    method: options.method,
    repo: options.repo,
    pr: options.pr,
    headSha: currentHeadSha,
    copilotConvergenceState: verdict.copilotConvergenceState,
    copilotDisposition: verdict.copilotDisposition,
    copilotCarriedConvergence: copilotAbsentReviewDisposition?.carriedConvergence ?? null,
    copilotBodyDisposition: verdict.copilotBodyDisposition,
  };
}

export async function main(argv = process.argv.slice(2), runtime = {}) {
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  let options;
  try {
    options = parseMergePrCliArgs(argv);
  } catch (error) {
    stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    return 1;
  }
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const result = await mergePr(options, runtime);
    return emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
  } catch (error) {
    if (error && typeof error === "object" && error.mergePrFailure) {
      stderr.write(`${JSON.stringify({ ...error.mergePrFailure, error: error.message })}\n`);
      return 1;
    }
    stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    return 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  process.exitCode = await main();
}
