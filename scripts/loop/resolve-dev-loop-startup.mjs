#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveAuthoritativeStartupResumeBundle } from "@dev-loops/core/loop/public-dev-loop-routing";
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { requireTokenValue, parsePositiveInteger } from "../_cli-primitives.mjs";
import { execFileSync } from "node:child_process";
import {
  isUnderWorktreePath,
  parseMainWorktreePath,
  isMainCheckout,
  parseAllWorktreePaths,
  isListedWorktree,
} from "@dev-loops/core/loop/worktree-guard";
import {
  validateAsyncStartContext,
  buildAsyncStartRejection,
  resolveEffectiveAsyncStartMode,
  ASYNC_START_STATUS,
} from "@dev-loops/core/loop/async-start-contract";
import { detectRepoSlug } from "@dev-loops/core/github/repo-slug";
import { isCopilotLogin } from "@dev-loops/core/github/copilot-helpers";
import {
  OWNERSHIP_STATE,
  classifyOwnership,
  ownershipNeedsViewerLogin,
} from "@dev-loops/core/github/ownership-helpers";
import { resolveLinkedIssuesFromPr } from "./detect-pr-gate-coordination-state.mjs";
import { loadDevLoopConfig, normalizeToBareBranch, resolveBaseBranch, resolveIssuelessEnabled, resolveLightMode, resolveWorkflowConfig } from "@dev-loops/core/config";
import { detectScope } from "./detect-change-scope.mjs";
import { createPiAdapter } from "@dev-loops/core/harness";
import { validatePlanFile } from "../refine/validate-plan-file.mjs";
import {
  validateSpikeExplorationSections,
  SPIKE_FILE_EXIT_MARKER_SECTION,
} from "../refine/validate-spike-file.mjs";
import { extractSection } from "../refine/_refine-helpers.mjs";
import {
  evaluatePlanFileIntakeState,
  PLAN_FILE_REFINEMENT_SECTIONS,
} from "@dev-loops/core/loop/plan-file-intake-contract";
import { evaluateSpikeIntakeState } from "@dev-loops/core/loop/spike-intake-contract";
import { loadBoardConfig } from "@dev-loops/core/loop/queue-board-sync";
import { main as reconcileQueue } from "../projects/reconcile-queue.mjs";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
const USAGE = `Usage:
  resolve-dev-loop-startup.mjs --issue <number>
  resolve-dev-loop-startup.mjs --pr <number>
  resolve-dev-loop-startup.mjs --input <path>
  resolve-dev-loop-startup.mjs --plan-file <path>
  resolve-dev-loop-startup.mjs --spike <path>
Resolve the authoritative public dev-loop startup/resume bundle.
Auto-resolves state from GitHub API, git remote, and settings when
--issue or --pr is used. Use --input for non-standard states.
Use --plan-file to start local planning from a phase-doc-format plan
(read-only: no tracker mutation, no issue/PR number).
Use --spike to start a time-boxed exploratory loop from a local spike
artifact (read-only: no tracker mutation, no issue/PR number).
Required (exactly one):
  --issue <n>    Target an issue by number (auto-resolves all state)
  --pr <n>       Target a PR by number (auto-resolves all state)
  --input <path>  Path to a JSON file with canonical-state payload
  --plan-file <path>  Path to a phase-doc-format plan to start locally
  --spike <path>  Path to a spike artifact to start a spike loop locally
Optional modifier:
  --ui-review    With --pr only: route the PR to the ui_review strategy
                 (running-app review from an isolated worktree) instead of
                 the default continue_on_pr/copilot_pr_followup path.
                 Rejected without --pr, or combined with --issue/--input/
                 --plan-file/--spike.
  --lightweight  With --issue: use the PR body as the spec-of-record
                 (canonicalSpecSource: pr_body) — no phase/plan doc minted or
                 committed. Same gate sequence; only the backing artifact
                 differs. Rejected with --plan-file (its opposite). The secondary
                 heuristic (chore/fix commit type + no --plan-file + small change)
                 is a documented manual signal; --lightweight is the explicit,
                 deterministic trigger.
                 Used ALONE (no --issue/--pr/--input/--plan-file/--spike):
                 issue-less PR-first (#1210) — no tracker binding at all
                 (canonicalSpecSource: pr_body, no issue-keyed worktree
                 requirement). Gated on localImplementation.lightMode being
                 enabled AND the live change scope (git diff) staying within
                 its maxFiles/maxLines threshold; fails closed with a distinct
                 reason (light mode disabled / scope undetectable / over
                 threshold) requiring --issue above the threshold — unless
                 localImplementation.issueless is set, which sanctions
                 issue-less PR-first at ANY change scope (the whole eligibility
                 gate is skipped; gate dispatch still resolves review depth
                 from scope on its own).
${JQ_OUTPUT_USAGE}

Exit codes:
  0  Success
  1  Argument error, runtime failure, or async-start contract rejection
  2  Invalid --jq filter`.trim();
// Upper bound on the awaited best-effort startup reconcile so a slow or hung gh
// can never delay startup completion.
const STARTUP_RECONCILE_BUDGET_MS = 20000;
const SHARED_PUBLIC_CONTRACT = "skills/docs/public-dev-loop-contract.md";
const SHARED_RETROSPECTIVE_CONTRACT = "skills/docs/retrospective-checkpoint-contract.md";
const STRATEGY_REQUIRED_READS = {
  local_implementation: [
    SHARED_PUBLIC_CONTRACT,
    "skills/local-implementation/SKILL.md",
  ],
  issue_intake: [
    SHARED_PUBLIC_CONTRACT,
    SHARED_RETROSPECTIVE_CONTRACT,
    "skills/copilot-pr-followup/SKILL.md",
    "skills/docs/copilot-loop-operations.md",
    "skills/docs/issue-intake-procedure.md",
  ],
  copilot_pr_followup: [
    SHARED_PUBLIC_CONTRACT,
    SHARED_RETROSPECTIVE_CONTRACT,
    "skills/copilot-pr-followup/SKILL.md",
    "skills/docs/copilot-loop-operations.md",
  ],
  external_pr_followup: [
    SHARED_PUBLIC_CONTRACT,
    SHARED_RETROSPECTIVE_CONTRACT,
    "skills/copilot-pr-followup/SKILL.md",
    "skills/docs/copilot-loop-operations.md",
  ],
  reviewer_fixer: [
    SHARED_PUBLIC_CONTRACT,
    SHARED_RETROSPECTIVE_CONTRACT,
    "skills/copilot-pr-followup/SKILL.md",
    "skills/docs/copilot-loop-operations.md",
  ],
  wait_watch: [
    SHARED_PUBLIC_CONTRACT,
    SHARED_RETROSPECTIVE_CONTRACT,
    "skills/copilot-pr-followup/SKILL.md",
    "skills/docs/copilot-loop-operations.md",
  ],
  final_approval: [
    SHARED_PUBLIC_CONTRACT,
    SHARED_RETROSPECTIVE_CONTRACT,
    "skills/copilot-pr-followup/SKILL.md",
    "skills/docs/copilot-loop-operations.md",
    "skills/final-approval/SKILL.md",
  ],
  ui_review: [
    SHARED_PUBLIC_CONTRACT,
    "skills/ui-review/SKILL.md",
  ],
  none: [SHARED_PUBLIC_CONTRACT],
};
const STRATEGY_ASYNC_DISPATCH = {
  local_implementation: false,
  issue_intake: true,
  copilot_pr_followup: true,
  external_pr_followup: true,
  reviewer_fixer: true,
  wait_watch: true,
  final_approval: false,
  ui_review: false,
  none: false,
};
// Single-contributor ownership gate scope (issue #1444 / ADR 0042, refining
// ADR 0033's universal gate): only code-changing or merge-authoritative
// sub-loops require ownership. Pure read/observe strategies (a running-app
// review, or waiting/watching an in-flight external run) never claim or
// write anything, so a reviewer must be able to run them against work they
// do not own. Unknown/unlisted strategies resolve to gated via the `?? true`
// fallback below — fail closed, matching every other unknown-key posture in
// this file (see the STRATEGY_REQUIRED_READS unknown-strategy-key throw).
export const STRATEGY_OWNERSHIP_GATE = {
  local_implementation: true,
  issue_intake: true,
  copilot_pr_followup: true,
  external_pr_followup: true,
  reviewer_fixer: true,
  final_approval: true,
  ui_review: false,
  wait_watch: false,
};
export function ownershipGateAppliesToStrategy(strategyKey) {
  return STRATEGY_OWNERSHIP_GATE[strategyKey] ?? true;
}
const parseError = buildParseError(USAGE);
export function parseResolveDevLoopStartupCliArgs(argv) {
  const options = {
    help: false,
    inputPath: undefined,
    issue: undefined,
    pr: undefined,
    planFile: undefined,
    spike: undefined,
    lightweight: false,
    uiReview: false,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      input: { type: "string" },
      issue: { type: "string" },
      pr: { type: "string" },
      "plan-file": { type: "string" },
      spike: { type: "string" },
      lightweight: { type: "boolean" },
      "ui-review": { type: "boolean" },
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
    if (token.name === "input") {
      options.inputPath = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "issue") {
      options.issue = parsePositiveInteger(requireTokenValue(token, parseError), "--issue", parseError);
      continue;
    }
    if (token.name === "pr") {
      options.pr = parsePositiveInteger(requireTokenValue(token, parseError), "--pr", parseError);
      continue;
    }
    if (token.name === "plan-file") {
      options.planFile = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "spike") {
      options.spike = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "lightweight") {
      options.lightweight = true;
      continue;
    }
    if (token.name === "ui-review") {
      options.uiReview = true;
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  const modeCount = [options.inputPath, options.issue, options.pr, options.planFile, options.spike].filter(v => v !== undefined).length;
  if (modeCount > 1) {
    throw parseError("--issue, --pr, --input, --plan-file, and --spike are mutually exclusive; provide exactly one");
  }
  // --ui-review is a PR-only selector: valid only alongside --pr, never with
  // --issue/--input/--plan-file/--spike, and never alone. Checked ahead of the
  // "no mode selected" error below so its rejection reason names --ui-review
  // specifically rather than falling through to the generic message.
  if (options.uiReview && options.pr === undefined) {
    throw parseError("--ui-review is only valid with --pr <n> (rejected with --issue, --input, --plan-file, --spike, or with no --pr).");
  }
  // --lightweight is normally a MODIFIER (not a 6th mode): it makes the PR body
  // the spec-of-record for the --issue local path. Used ALONE (modeCount === 0,
  // issue #1210) it is instead the issue-less PR-first trigger — no tracker
  // binding at all — so the "no mode selected" error is skipped in that case.
  if (modeCount === 0 && !options.lightweight) {
    throw parseError("--input <path>, --issue <n>, --pr <n>, --plan-file <path>, --spike <path>, or --lightweight (issue-less PR-first) is required");
  }
  // --lightweight is the opposite of --plan-file (which commits a durable plan
  // doc as the spec) regardless of mode.
  if (options.lightweight && options.planFile !== undefined) {
    throw parseError("--lightweight and --plan-file are opposites: --plan-file commits a durable plan doc as the spec-of-record, --lightweight makes the PR body the spec. Provide only one.");
  }
  // When another mode IS selected, --lightweight only composes with --issue
  // (not --pr/--input/--spike). Used with no mode selected at all, it is the
  // issue-less PR-first trigger handled above.
  if (options.lightweight && modeCount > 0 && options.issue === undefined) {
    throw parseError("--lightweight is a modifier for the --issue path (the PR body becomes the spec-of-record). Combine it with --issue <n>, or use --lightweight alone (no other mode flag) for the issue-less PR-first path.");
  }
  return options;
}
function ghJson(args, cwd) {
  try {
    const stdout = execFileSync("gh", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`gh command failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function mapGhState(ghState) {
  const s = String(ghState).toUpperCase();
  if (s === "OPEN") return "open";
  if (s === "CLOSED") return "closed";
  if (s === "MERGED") return "merged";
  throw new Error(`Unknown GitHub state: "${ghState}"`);
}
// Single-contributor ownership gate (issue #1377): resolved once per CLI run
// and memoized, since both the --issue and --pr paths (and, within the --pr
// path, the linked-issue check) may need it. `gh api user` failing means we
// cannot verify OR claim ownership at all, so it fails closed with its own
// distinct reason rather than falling back to a default.
let viewerLoginCache = null;
function resolveViewerLogin(cwd) {
  if (viewerLoginCache !== null) return viewerLoginCache;
  let login;
  try {
    login = ghJson(["api", "user"], cwd)?.login;
  } catch (err) {
    throw new Error(
      `Unable to resolve the current GitHub viewer login (gh api user failed: ${err instanceof Error ? err.message : String(err)}); cannot verify or claim single-contributor ownership — fail closed, do not start. Check \`gh auth status\` and retry.`,
    );
  }
  if (typeof login !== "string" || login.length === 0) {
    throw new Error(
      "gh api user returned no login; cannot verify or claim single-contributor ownership — fail closed, do not start.",
    );
  }
  viewerLoginCache = login;
  return login;
}
// Classify assignees against the viewer, resolving the viewer login only when
// a non-copilot assignee is present (keeps the copilot flow and the genuinely
// empty-assignees case immune to viewer-login resolution failures).
function resolveOwnershipState(assignees, cwd) {
  const viewerLogin = ownershipNeedsViewerLogin(assignees) ? resolveViewerLogin(cwd) : null;
  return classifyOwnership(assignees, viewerLogin);
}
// Unassigned work is impossible by construction (#1377): the startup resolver
// requires assigned_to_me and fails closed on anything else. assigned_to_other
// names the foreign assignee(s); unassigned names the exact claim command so
// the caller can self-heal (claim, then re-run) instead of guessing.
function enforceOwnershipGate(ownership, { describeArtifact, claimCommand }) {
  if (ownership.state === OWNERSHIP_STATE.ASSIGNED_TO_OTHER) {
    throw new Error(
      `${describeArtifact} is assigned to ${ownership.foreignLogins.join(", ")}, not the current viewer; fail closed — do not start. Have the owner unassign it, or pick a different item.`,
    );
  }
  if (ownership.state === OWNERSHIP_STATE.UNASSIGNED) {
    throw new Error(
      `${describeArtifact} is not claimed by any contributor; fail closed — do not start. Claim it first: ${claimCommand}`,
    );
  }
}
// Read-only inspection tools (e.g. `info.mjs`, which previews routing without
// starting or claiming anything) opt out of the ownership gate with this var —
// it must NEVER be set on a sanctioned start/continue path.
const OWNERSHIP_GATE_BYPASS_VAR = "DEVLOOPS_OWNERSHIP_BYPASS";
function ownershipGateBypassed(env) {
  return (env?.[OWNERSHIP_GATE_BYPASS_VAR] ?? "").trim() === "1";
}
function hasAcSection(body) {
  if (typeof body !== "string" || body.length === 0) return false;
  return /##\s*Acceptance Criteria|##\s*AC\b|###\s*Acceptance Criteria|###\s*AC\b/i.test(body);
}
function resolveTargetPreference(cwd) {
  const devloopsCandidates = [
    path.join(cwd, ".devloops"),
    path.join(cwd, ".devloops.yaml"),
    path.join(cwd, ".devloops.yml"),
    path.join(cwd, ".devloops.json"),
  ];
  // Check .devloops first (bare or with extension).
  // Bare files try YAML first, then JSON fallback (consistent with
  // config.mjs readConfigFile behavior).
  for (const devloopsPath of devloopsCandidates) {
    try {
      const raw = readFileSync(devloopsPath, "utf8");
      let val;
      if (devloopsPath.endsWith(".json")) {
        val = JSON.parse(raw)?.strategy;
      } else if (devloopsPath.endsWith(".yaml") || devloopsPath.endsWith(".yml")) {
        const m = raw.match(/^strategy:\s*["']?([^"'\s]+)["']?/m);
        val = m ? m[1] : undefined;
      } else {
        // Bare file (no recognized extension) — YAML first, JSON fallback
        const m = raw.match(/^strategy:\s*["']?([^"'\s]+)["']?/m);
        if (m) {
          val = m[1];
        } else {
          try {
            val = JSON.parse(raw)?.strategy;
          } catch {
            // Not valid JSON either — fall through
          }
        }
      }
      if (val === "local-first") return "prefer_local";
      // "tracker-first" is the canonical value (#1408, the tracker-agnostic
      // seam); "github-first" is still accepted here as the deprecated alias
      // (this scraper reads the raw file directly, bypassing config.mjs's
      // own alias normalization, so it must recognize both literals itself).
      if (val === "tracker-first" || val === "github-first") return "prefer_github_first";
    } catch {
    }
  }
  // Legacy .pi/dev-loop/settings.* (deprecated)
  const legacyCandidates = [
    path.join(cwd, ".pi", "dev-loop", "settings.yaml"),
    path.join(cwd, ".pi", "dev-loop", "settings.yml"),
    path.join(cwd, ".pi", "dev-loop", "settings.json"),
  ];
  for (const settingsPath of legacyCandidates) {
    try {
      const raw = readFileSync(settingsPath, "utf8");
      if (settingsPath.endsWith(".json")) {
        const parsed = JSON.parse(raw);
        const val = parsed?.strategy;
        if (val === "local-first") return "prefer_local";
        if (val === "tracker-first" || val === "github-first") return "prefer_github_first";
        continue;
      }
      const match = raw.match(/^strategy:\s*["']?([^"'\s]+)["']?/m);
      if (match) {
        if (match[1] === "local-first") return "prefer_local";
        if (match[1] === "tracker-first" || match[1] === "github-first") return "prefer_github_first";
      }
    } catch {
    }
  }
  return "prefer_local";
}
function normalizeConfigInputSource(value) {
  if (value === "phase-docs") return "phase-docs";
  if (value === "tracker") return "tracker";
  return "tracker";
}
export function buildAutoResolvedInput({ issue, pr, cwd, targetPreference, inputSource, uiReview = false, env = process.env }) {
  // The viewer-login memo exists to dedupe gh calls WITHIN one resolution
  // (PR + linked-issue checks); reset it per invocation so a long-lived
  // process (or test) never reuses a stale login across resolutions.
  viewerLoginCache = null;
  let repoRoot = cwd;
  try {
    repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
  }
  const repo = detectRepoSlug(repoRoot);
  if (!repo) {
    throw new Error("Repo auto-detection failed. Set origin remote or use --input.");
  }
  if (issue !== undefined) {
    const resolvedTargetPreference = targetPreference ?? resolveTargetPreference(repoRoot);
    const resolvedInputSource = normalizeConfigInputSource(inputSource);
    if (resolvedTargetPreference === "prefer_local" && resolvedInputSource === "phase-docs") {
      return {
        intent: "start_issue_locally",
        mode: "bounded_handoff",
        targetPreference: resolvedTargetPreference,
        artifactState: "not_applicable",
        issueLinkageResolution: "not_applicable",
        issueReadiness: "not_applicable",
        issueAssignmentState: "not_applicable",
        loopState: "implementation_pending",
        currentState: {
          target: { kind: "local_phase", issue, pr: null, linkedPr: null, branch: null, phase: `issue-${issue}` },
          ownership: "local",
          nextActor: "local",
          status: "active",
          authorization: "authorized",
        },
      };
    }
    let artifactState = "not_applicable";
    const warnings = [];
    let issueLinkageResolution = "resolved_no_open_pr";
    let linkedPr = null;
    let ownership = "local";
    let linkagePayload = null;
    try {
      const linkageJson = execFileSync(process.execPath, [
        path.join(repoRoot, "scripts/github/detect-linked-issue-pr.mjs"),
        "--repo", repo, "--issue", String(issue),
      ], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      linkagePayload = JSON.parse(linkageJson);
    } catch (err) {
      // Fail closed (#1626): a transient gh failure must NOT fabricate
      // `resolved_no_open_pr` — that self-consistent default would route an
      // issue that HAS an open linked PR to `issue_intake`, which the router
      // cannot catch. Refuse rather than guess.
      throw new Error(
        `issueLinkageResolution: linked-PR detection failed for issue #${issue} (${err instanceof Error ? err.message : String(err)}) — refusing to fabricate "resolved_no_open_pr" because a transient failure would misroute an issue that has an open linked PR. Re-run once GitHub/detect-linked-issue-pr is reachable.`,
      );
    }
    if (linkagePayload?.hasOpenLinkedPr) {
      issueLinkageResolution = "resolved_linked_pr";
      linkedPr = linkagePayload.prNumber;
      try {
        const prJson = ghJson(["pr", "view", String(linkedPr), "--repo", repo, "--json", "author,state"], repoRoot);
        ownership = isCopilotLogin(prJson?.author?.login) ? "copilot" : "external_human";
        artifactState = mapGhState(prJson?.state ?? "OPEN");
      } catch {
        warnings.push(
          `linkedPr authorship: using default ownership "${ownership}" for PR #${linkedPr} — gh pr view failed`,
        );
      }
    }
    let issueReadiness;
    try {
      const issueJson = ghJson(["issue", "view", String(issue), "--repo", repo, "--json", "body"], repoRoot);
      issueReadiness = hasAcSection(issueJson.body) ? "ready" : "needs_clarification";
    } catch {
      issueReadiness = "needs_clarification";
      warnings.push(`issueReadiness: using default "${issueReadiness}" — gh issue view failed`);
    }
    // Single-contributor ownership gate (#1377, scoped by #1444): a failed
    // read defaults to an empty assignee list (today's warn+default posture
    // for the READ). Classification here uses `classifyOwnership(assignees,
    // null)` — never the viewer login — because the copilot check
    // short-circuits before any viewer comparison, so this is always safe
    // regardless of gate/bypass state and is enough to derive
    // issueAssignmentState (which only distinguishes copilot vs not-copilot;
    // see the comment below). The real ownership-gate ENFORCEMENT (which does
    // need the viewer login to tell assigned_to_me from assigned_to_other) is
    // deferred below, after peeking the strategy the pure routing evaluator
    // would select for this canonical state.
    let assignees = [];
    try {
      const assigneesJson = ghJson(["issue", "view", String(issue), "--repo", repo, "--json", "assignees"], repoRoot);
      assignees = assigneesJson.assignees || [];
    } catch {
      warnings.push('issueAssignmentState: using default "unassigned" — gh issue view failed');
    }
    const routingOwnership = classifyOwnership(assignees, null);
    // Only assigned_to_me and assigned_to_copilot pass the gate below. The pure
    // routing evaluator's issueAssignmentState authoritative issue-state input
    // (not a variation parameter — see public-dev-loop-contract.md) only
    // distinguishes copilot vs not-copilot (DEV_LOOP_ISSUE_ASSIGNMENT_STATE has
    // no assigned_to_me value) — assigned_to_me is passed through as
    // "unassigned" for that purpose; the gate below already proves the viewer
    // is the sole human owner whenever it applies.
    const issueAssignmentState = routingOwnership.state === OWNERSHIP_STATE.ASSIGNED_TO_COPILOT
      ? "assigned_to_copilot"
      : "unassigned";
    const loopState = "issue_intake_start";
    const result = {
      intent: "start_issue_locally",
      mode: "bounded_handoff",
      targetPreference: resolvedTargetPreference,
      artifactState,
      issueLinkageResolution,
      issueReadiness,
      issueAssignmentState,
      loopState,
      warnings: warnings.length > 0 ? warnings : undefined,
      currentState: {
        target: { kind: "issue", issue, pr: null, linkedPr, branch: null, phase: null },
        ownership: ownership,
        nextActor: ownership === "copilot"
          ? "copilot"
          : ownership === "external_human"
            ? "external_human" : "local",
        status: "active",
        authorization: "authorized",
      },
    };
    // Scoped single-contributor ownership gate (#1444, ADR 0042): peek the
    // strategy the pure routing evaluator would select for this exact
    // canonical state, then enforce ownership only when that strategy is
    // gated (STRATEGY_OWNERSHIP_GATE). Every strategy reachable from the
    // --issue path today (local_implementation, issue_intake) is gated, so
    // this peek is defensive/future-proofing rather than a live branch — but
    // it is the one mechanism, shared with the --pr path below, so a future
    // issue-reachable exempt strategy is covered for free. Bypassed
    // (read-only inspection, e.g. info.mjs) skips enforcement entirely,
    // regardless of strategy — resolveAuthoritativeStartupResumeBundle itself
    // never shells out, so this peek costs no extra gh calls.
    if (!ownershipGateBypassed(env)) {
      const peekedStrategy = resolveAuthoritativeStartupResumeBundle(result).selectedStrategy ?? "none";
      if (ownershipGateAppliesToStrategy(peekedStrategy)) {
        enforceOwnershipGate(resolveOwnershipState(assignees, repoRoot), {
          describeArtifact: `Issue #${issue}`,
          claimCommand: `node scripts/github/edit-issue.mjs --repo ${repo} --issue ${issue} --add-assignee @me`,
        });
      }
    }
    return result;
  }
  let artifactState;
  let prAssignees = [];
  let linkedIssueNumbers = [];
  try {
    const prJson = ghJson(
      ["pr", "view", String(pr), "--repo", repo, "--json", "state,mergedAt,assignees,closingIssuesReferences,body"],
      repoRoot,
    );
    artifactState = prJson.mergedAt ? "merged" : mapGhState(prJson.state);
    prAssignees = prJson.assignees || [];
    linkedIssueNumbers = resolveLinkedIssuesFromPr(prJson);
  } catch {
    artifactState = "open";
  }
  const resolvedTargetPreference = targetPreference ?? resolveTargetPreference(repoRoot);
  // `--ui-review` (issue #1362) routes the PR to the ui_review strategy
  // instead of the default continue_on_pr/copilot_pr_followup path; every
  // other field (ownership/nextActor/artifactState/etc.) stays identical —
  // only intent + loopState change, and only when the flag is set, so the
  // plain --pr path is byte-unchanged.
  const result = {
    intent: uiReview ? "review_pr_ui" : "continue_on_pr",
    mode: "bounded_handoff",
    targetPreference: resolvedTargetPreference,
    artifactState,
    issueLinkageResolution: "not_applicable",
    loopState: uiReview ? "pr_ui_review_start" : "pr_followup_start",
    currentState: {
      target: { kind: "pr", issue: null, pr, linkedPr: null, branch: null, phase: null },
      ownership: "copilot",
      nextActor: "user",
      status: "active",
      authorization: "authorized",
    },
  };
  // Scoped single-contributor ownership gate (#1377, scoped by #1444 / ADR
  // 0042): peek the strategy the pure routing evaluator would select for this
  // canonical state (ui_review for --ui-review, one of the
  // copilot/external/reviewer-fixer follow-up strategies otherwise), then
  // enforce ownership — including the linked-issue foreign check — only when
  // that strategy is gated. A ui_review peek is exempt, so a reviewer can run
  // `/loop-review-ui` against a PR (and its linked issue) they do not own.
  // Bypassed (read-only inspection): skip enforcement entirely, mirroring the
  // --issue path above.
  if (!ownershipGateBypassed(env)) {
    const peekedStrategy = resolveAuthoritativeStartupResumeBundle(result).selectedStrategy ?? "none";
    if (ownershipGateAppliesToStrategy(peekedStrategy)) {
      const prOwnership = resolveOwnershipState(prAssignees, repoRoot);
      enforceOwnershipGate(prOwnership, {
        describeArtifact: `PR #${pr}`,
        claimCommand: `node scripts/github/edit-pr.mjs --repo ${repo} --pr ${pr} --add-assignee @me`,
      });
      // A PR whose linked issue is foreign-owned is foreign too — the issue
      // owner owns the whole loop. This only checks for a FOREIGN linked
      // issue (not unassigned): the PR's own ownership above already gates
      // the unclaimed case, and an unassigned linked issue is not evidence
      // anyone else owns it. Copilot-assigned PRs short-circuit: the
      // Copilot-first flow governs them, and their path stays immune to
      // viewer-login resolution entirely.
      for (const linkedIssueNumber of prOwnership.state === OWNERSHIP_STATE.ASSIGNED_TO_COPILOT ? [] : linkedIssueNumbers) {
        let linkedIssueAssignees;
        try {
          const linkedIssueJson = ghJson(["issue", "view", String(linkedIssueNumber), "--repo", repo, "--json", "assignees"], repoRoot);
          linkedIssueAssignees = linkedIssueJson.assignees || [];
        } catch {
          // Warn-on-failure posture, same as other reads: an unreadable linked
          // issue cannot block continuation on its own.
          continue;
        }
        const linkedIssueOwnership = resolveOwnershipState(linkedIssueAssignees, repoRoot);
        if (linkedIssueOwnership.state === OWNERSHIP_STATE.ASSIGNED_TO_OTHER) {
          throw new Error(
            `PR #${pr}'s linked issue #${linkedIssueNumber} is assigned to ${linkedIssueOwnership.foreignLogins.join(", ")}, not the current viewer; the issue owner owns the whole loop — fail closed, do not continue. Have the owner unassign it, or pick a different item.`,
          );
        }
      }
    }
  }
  return result;
}
/**
 * Read + validate a `--plan-file` path and build a local_phase startup input.
 *
 * Read-only: no tracker mutation, no GitHub calls, no issue/PR number. A
 * missing/unreadable file, or one failing the base-section validator, throws so
 * the CLI fails closed (exit 1, no readiness bundle). The plan-file path is
 * carried as the target `phase` and is exempt from the worktree-isolation guard
 * because there is no issue to key a worktree on before promotion.
 *
 * @returns {object} startup input with a `planFileIntakeState` field threaded onto output
 */
export function buildPlanFileInput({ planFilePath }) {
  const resolvedPath = path.resolve(planFilePath);
  let markdownText;
  try {
    markdownText = readFileSync(resolvedPath, "utf8");
  } catch (err) {
    throw new Error(`Plan file is missing or unreadable: ${resolvedPath} (${err instanceof Error ? err.message : String(err)})`);
  }
  const validation = validatePlanFile(markdownText);
  if (!validation.ok) {
    const codes = validation.errors.map(e => e.code).join(", ");
    throw new Error(`Plan file failed validation (${resolvedPath}): ${codes}`);
  }
  // Refined-vs-needs-refinement: refinement adds Acceptance criteria + Definition
  // of done on top of the base authoring sections. Detect each via extractSection
  // (non-null trimmed body == present and non-empty), then classify with the pure
  // intake evaluator.
  const [acHeading, dodHeading] = PLAN_FILE_REFINEMENT_SECTIONS;
  const hasAcceptanceCriteria = extractSection(markdownText, acHeading) ? true : false;
  const hasDefinitionOfDone = extractSection(markdownText, dodHeading) ? true : false;
  const { state: planFileIntakeState } = evaluatePlanFileIntakeState({
    baseSectionsValid: true,
    hasAcceptanceCriteria,
    hasDefinitionOfDone,
  });
  return {
    intent: "start_issue_locally",
    mode: "bounded_handoff",
    targetPreference: "prefer_local",
    artifactState: "not_applicable",
    issueLinkageResolution: "not_applicable",
    issueReadiness: "not_applicable",
    issueAssignmentState: "not_applicable",
    loopState: "implementation_pending",
    planFileIntakeState,
    planFileExempt: true,
    currentState: {
      target: { kind: "local_phase", issue: null, pr: null, linkedPr: null, branch: null, phase: resolvedPath },
      ownership: "local",
      nextActor: "local",
      status: "active",
      authorization: "authorized",
    },
  };
}
/**
 * Read + validate a `--spike` path and build a local_phase startup input for a
 * time-boxed exploratory loop.
 *
 * Read-only: no tracker mutation, no GitHub calls, no issue/PR number — a spike
 * is startable from a local question with no GitHub issue and no production-gate
 * ceremony at entry. A missing/unreadable file, or one missing the exploration
 * scaffold (Question/Approach/Findings), throws so the CLI fails closed (exit 1,
 * no readiness bundle). The Recommendation section is filled in during the spike;
 * its presence flips the intake state to spike_ready_for_exit (the seam phase 2's
 * discard/graduate exits consume). The spike path is carried as the target
 * `phase` and is exempt from the worktree-isolation guard because there is no
 * issue to key a worktree on.
 *
 * @returns {object} startup input with a `spikeIntakeState` field threaded onto output
 */
export function buildSpikeInput({ spikeFilePath }) {
  const resolvedPath = path.resolve(spikeFilePath);
  let markdownText;
  try {
    markdownText = readFileSync(resolvedPath, "utf8");
  } catch (err) {
    throw new Error(`Spike file is missing or unreadable: ${resolvedPath} (${err instanceof Error ? err.message : String(err)})`);
  }
  // Entry gate: the exploration scaffold must be present and non-empty. A
  // malformed spike artifact fails closed before any intake classification.
  const validation = validateSpikeExplorationSections(markdownText);
  if (!validation.ok) {
    const codes = validation.errors.map(e => e.code).join(", ");
    throw new Error(`Spike file failed validation (${resolvedPath}): ${codes}`);
  }
  const hasRecommendation = extractSection(markdownText, SPIKE_FILE_EXIT_MARKER_SECTION) ? true : false;
  const { state: spikeIntakeState } = evaluateSpikeIntakeState({
    baseSectionsValid: true,
    hasRecommendation,
  });
  return {
    intent: "start_issue_locally",
    mode: "bounded_handoff",
    targetPreference: "prefer_local",
    artifactState: "not_applicable",
    issueLinkageResolution: "not_applicable",
    issueReadiness: "not_applicable",
    issueAssignmentState: "not_applicable",
    loopState: "implementation_pending",
    spikeIntakeState,
    planFileExempt: true,
    currentState: {
      target: { kind: "local_phase", issue: null, pr: null, linkedPr: null, branch: null, phase: resolvedPath },
      ownership: "local",
      nextActor: "local",
      status: "active",
      authorization: "authorized",
    },
  };
}
// Candidate default-branch refs for issue-less scope measurement, in preference
// order. origin/HEAD tracks the remote default branch when set; the rest cover
// the common names.
const ISSUELESS_BASE_REF_CANDIDATES = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];

function resolveIssuelessMergeBase(cwd, candidates) {
  for (const ref of candidates) {
    try {
      return execFileSync("git", ["merge-base", ref, "HEAD"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Non-empty trimmed `workflow.baseBranch`, or `null` when unset/malformed —
 * mirrors resolveBaseBranch's own "config wins" validity check. */
function configuredBaseBranch(config) {
  const raw = config?.workflow?.baseBranch;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  // Reduce to a bare branch name (same as resolveBaseBranch) so the later
  // `origin/${configuredBase}` candidate can't become `origin/origin/main`. A
  // prefix-only value (e.g. "origin/") normalizes to empty — treat as unset.
  const bare = normalizeToBareBranch(raw.trim());
  return bare.length > 0 ? bare : null;
}

/**
 * Decide whether the live change scope is eligible for issue-less lightweight
 * PR-first (#1210): reuses the same localImplementation.lightMode threshold
 * that gates inline vs full-fanout gate dispatch, so "genuinely small" means
 * the same thing everywhere in the repo.
 *
 * Scope is measured from the merge-base with the default branch to the WORKING
 * TREE (`git diff --stat <merge-base>`), so multi-commit branches and
 * uncommitted changes are both counted — a HEAD~1-only measure would fail OPEN
 * on a branch whose earlier commits already exceed the threshold. Fails CLOSED
 * on every negative path (disabled / no resolvable base / undetectable diff /
 * over threshold) with a distinct reason so the caller can report why --issue
 * is required instead of silently defaulting one way or the other.
 *
 * Every git invocation is bound to `cwd` (the adapter-resolved repoRoot),
 * matching the rest of this file's git calls — process.cwd() is never relied
 * on implicitly so this stays correct when invoked from a subdirectory or
 * with a harness cwd that differs from the OS process cwd.
 *
 * @param {import("@dev-loops/core/config").DevLoopConfig} config
 * @param {string} [cwd] - Repo root to run git commands in (defaults to process.cwd() when omitted).
 * @returns {{ eligible: true, scope: object, threshold: {maxFiles:number,maxLines:number} } | { eligible: false, reason: "light_mode_disabled"|"scope_detection_failed"|"over_threshold", scope?: object, threshold?: object, detail?: string }}
 */
export function resolveIssuelessLightweightEligibility(config, cwd) {
  const threshold = resolveLightMode(config);
  if (!threshold) {
    return { eligible: false, reason: "light_mode_disabled" };
  }
  // A configured workflow.baseBranch (#1368) takes priority over the generic
  // candidate list — the whole point of the config knob is that the default
  // branch is NOT the right merge-base (e.g. a spike branch that must never
  // measure scope against main). Unset stays the exact prior candidate list
  // and order (byte-for-byte no-regression).
  const configuredBase = configuredBaseBranch(config);
  const candidates = configuredBase
    ? [`origin/${configuredBase}`, configuredBase]
    : ISSUELESS_BASE_REF_CANDIDATES;
  const mergeBase = resolveIssuelessMergeBase(cwd, candidates);
  if (mergeBase === null) {
    return {
      eligible: false,
      reason: "scope_detection_failed",
      detail: `no merge-base with any default-branch candidate (${candidates.join(", ")})`,
    };
  }
  // detectScope with only `base` diffs base..working-tree in one measure
  // (committed branch delta + uncommitted changes).
  const scope = detectScope({ base: mergeBase, cwd });
  if (scope.ok === false) {
    return { eligible: false, reason: "scope_detection_failed", detail: scope.error };
  }
  if (scope.filesChanged > threshold.maxFiles || scope.linesChanged > threshold.maxLines) {
    return { eligible: false, reason: "over_threshold", scope, threshold };
  }
  return { eligible: true, scope, threshold };
}

/**
 * Build a `--lightweight` startup input with NO tracker binding at all
 * (issue-less PR-first, #1210): `--lightweight` used alone, no --issue.
 *
 * Read-only: no tracker mutation, no GitHub calls, no issue/PR number. Gated
 * by {@link resolveIssuelessLightweightEligibility} — unless
 * `localImplementation.issueless` (#1349) sanctions any-scope
 * issue-less PR-first, in which case the eligibility gate is skipped entirely.
 * Otherwise an ineligible change
 * throws so the CLI fails closed (exit 1, no readiness bundle) with a message
 * naming the distinct reason, mirroring buildPlanFileInput/buildSpikeInput's
 * fail-closed-on-invalid-input convention. Exempt from the worktree-isolation
 * guard like the plan-file/spike paths: there is no issue number to key a
 * worktree on.
 *
 * @param {{ config: import("@dev-loops/core/config").DevLoopConfig, cwd?: string }} params
 * @returns {object} startup input with canonicalSpecSource: "pr_body"
 */
export function buildLightweightIssuelessInput({ config, cwd }) {
  // localImplementation.issueless (#1349) sanctions issue-less
  // PR-first at ANY change scope — for consumers whose spec of record lives
  // in an external tracker and who cannot mint a GitHub issue for big work.
  // Review depth is unaffected: gate dispatch re-measures scope itself and
  // fails safe to full_fanout over threshold.
  if (!resolveIssuelessEnabled(config)) {
    const eligibility = resolveIssuelessLightweightEligibility(config, cwd);
    if (!eligibility.eligible) {
      if (eligibility.reason === "light_mode_disabled") {
        throw new Error("--lightweight without --issue (issue-less PR-first) requires localImplementation.lightMode.enabled in .devloops; enable light mode, set localImplementation.issueless for any-scope issue-less PR-first, or provide --issue <n>.");
      }
      if (eligibility.reason === "scope_detection_failed") {
        throw new Error(`--lightweight without --issue (issue-less PR-first) requires a measurable change scope; git diff failed (${eligibility.detail}). Set localImplementation.issueless for any-scope issue-less PR-first, or provide --issue <n>.`);
      }
      throw new Error(`--lightweight without --issue (issue-less PR-first) requires the change to stay within the light-mode threshold (maxFiles=${eligibility.threshold.maxFiles}, maxLines=${eligibility.threshold.maxLines}); this change is ${eligibility.scope.filesChanged} files / ${eligibility.scope.linesChanged} lines. Set localImplementation.issueless for any-scope issue-less PR-first, or provide --issue <n>.`);
    }
  }
  return {
    intent: "start_issue_locally",
    mode: "bounded_handoff",
    targetPreference: "prefer_local",
    artifactState: "not_applicable",
    issueLinkageResolution: "not_applicable",
    issueReadiness: "not_applicable",
    issueAssignmentState: "not_applicable",
    loopState: "implementation_pending",
    canonicalSpecSource: "pr_body",
    planFileExempt: true,
    currentState: {
      target: { kind: "local_phase", issue: null, pr: null, linkedPr: null, branch: null, phase: "lightweight-issueless" },
      ownership: "local",
      nextActor: "local",
      status: "active",
      authorization: "authorized",
    },
  };
}
export function summarizeCanonicalState(bundle) {
  return {
    target: bundle.canonicalState?.target ?? null,
    ownership: bundle.canonicalState?.ownership ?? null,
    nextActor: bundle.canonicalState?.nextActor ?? null,
    status: bundle.canonicalState?.status ?? null,
    authorization: bundle.canonicalState?.authorization ?? null,
    artifactState: bundle.artifactState ?? null,
    issueLinkageResolution: bundle.issueLinkageResolution ?? null,
    loopState: bundle.loopState ?? null,
    routeKind: bundle.routeKind ?? null,
    selectedGate: bundle.selectedGate ?? null,
    executionMode: bundle.executionMode ?? null,
    waitSemantics: bundle.waitSemantics ?? null,
    requiresAsyncDispatch: bundle.selectedStrategy !== null
      ? (STRATEGY_ASYNC_DISPATCH[bundle.selectedStrategy] ?? false)
      : false,
  };
}
export function buildResolveDevLoopStartupResult(input, { adapter = createPiAdapter(), env, cwd, asyncStartMode = "required", config } = {}) {
  const effectiveEnv = env ?? adapter.getEnv();
  const effectiveCwd = cwd ?? adapter.getCwd();
  // A configured workflow.baseBranch (#1368) is surfaced in the worktree
  // nextAction hint below as an explicit `--base origin/<baseBranch>` — unset
  // is omitted entirely since ensure-worktree.mjs already auto-detects the
  // same default itself (see resolveBaseBranch).
  const configuredBase = configuredBaseBranch(config);
  const worktreeHintBaseFlag = configuredBase ? ` --base origin/${resolveBaseBranch(config, { cwd: effectiveCwd })}` : "";
  // Normalize a non-object input (e.g. `--input null`, which parses to a legal
  // JSON null) to {} so the destructure below cannot throw before routing can
  // fail closed with a structured reconcile bundle.
  if (input === null || typeof input !== "object") input = {};
  // Plan-file intake carries two resolver-only fields that the pure routing
  // evaluator does not model. Strip them before evaluation and re-apply them to
  // the result; `planFileExempt` waives the worktree-isolation guard because a
  // pre-promotion plan has no issue to key a worktree on.
  // `canonicalSpecSource` (issue #1025) is a resolver-only field the pure routing
  // evaluator does not model — strip it before evaluation and re-attach to the
  // result, mirroring planFileIntakeState/spikeIntakeState.
  const { planFileExempt = false, planFileIntakeState = null, spikeIntakeState = null, canonicalSpecSource = null, ...routingInput } = input;
  input = routingInput;
  try {
    const checkpointText = readFileSync(
      path.join(effectiveCwd, ".pi", "dev-loop-retrospective-checkpoint.json"),
      "utf8",
    );
    const checkpoint = JSON.parse(checkpointText);
    const rawState = checkpoint?.state;
    const DURABLE_STATE_MAP = {
      none: "none",
      complete: "complete",
      skipped: "skipped",
      missing: "missing",
      required: "missing",  // durable artifact uses "required" to mean pending retrospective
    };
    const normalizedRaw = typeof rawState === "string" ? rawState.trim().toLowerCase() : null;
    const mappedState = DURABLE_STATE_MAP[normalizedRaw] ?? null;
    if (mappedState) {
      input = { ...input, retrospectiveCheckpointState: mappedState };
    } else {
      input = { ...input, retrospectiveCheckpointState: "missing" };
    }
  } catch (err) {
    if (err?.code === "ENOENT") {
    } else {
      input = { ...input, retrospectiveCheckpointState: "missing" };
    }
  }
  const bundle = resolveAuthoritativeStartupResumeBundle(input);
  const strategyKey = bundle.selectedStrategy ?? "none";
  if (!(strategyKey in STRATEGY_REQUIRED_READS)) {
    throw new Error(
      `Unknown strategy key "${strategyKey}" is not in the allowed strategy required-reads map. ` +
      `Update STRATEGY_REQUIRED_READS to include this strategy or check for a core routing contract drift.`,
    );
  }
  const requiresAsyncDispatch = bundle.selectedStrategy !== null
    ? (STRATEGY_ASYNC_DISPATCH[bundle.selectedStrategy] ?? false)
    : false;
  if (requiresAsyncDispatch) {
    // The configured async-start mode is relaxed to "allowed" under the Claude
    // harness, where the Pi async-subagent start contract does not apply.
    const effectiveAsyncStartMode = resolveEffectiveAsyncStartMode(asyncStartMode, effectiveEnv);
    const validation = validateAsyncStartContext({ env: effectiveEnv, asyncStartMode: effectiveAsyncStartMode });
    if (validation.status === ASYNC_START_STATUS.REJECTED) {
      return buildAsyncStartRejection(validation);
    }
  }
  const DEVLOOPS_WORKTREE_BYPASS_VAR = "DEVLOOPS_WORKTREE_BYPASS";
  if (
    strategyKey === "local_implementation" &&
    !planFileExempt &&
    (effectiveEnv[DEVLOOPS_WORKTREE_BYPASS_VAR] ?? "").trim() !== "1"
  ) {
    try {
      const worktreeOutput = execFileSync("git", ["worktree", "list"], {
        cwd: effectiveCwd,
        env: effectiveEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const mainPath = parseMainWorktreePath(worktreeOutput);
      const allPaths = parseAllWorktreePaths(worktreeOutput);
      if (!isUnderWorktreePath(effectiveCwd)) {
        const reason = mainPath !== null && isMainCheckout(effectiveCwd, mainPath)
          ? `Local implementation requires worktree isolation. Current directory is the main git checkout (${mainPath}). Run \`node scripts/loop/ensure-worktree.mjs --repo-root ${mainPath} --issue <n>${worktreeHintBaseFlag}\` to create+provision the worktree under tmp/worktrees/dev-loops/<kind>-<n>, then re-run from there.`
          : `Local implementation requires worktree isolation. Current directory is not under tmp/worktrees/. Run \`node scripts/loop/ensure-worktree.mjs --repo-root <main> --issue <n>${worktreeHintBaseFlag}\` to create+provision a worktree under tmp/worktrees/dev-loops/<kind>-<n>, then re-run from there.`;
        return {
          ok: true,
          bundleKind: "needs_reconcile",
          selectedStrategy: "none",
          requiredReads: STRATEGY_REQUIRED_READS["none"],
          nextAction: reason,
          canonicalStateSummary: summarizeCanonicalState(bundle),
          bundle,
        };
      }
      if (!isListedWorktree(effectiveCwd, allPaths)) {
        const reason = `Local implementation requires worktree isolation. Current directory is under tmp/worktrees/ but is not listed as a git worktree by \`git worktree list\`. Create a proper worktree with \`node scripts/loop/ensure-worktree.mjs --repo-root <main> --issue <n>${worktreeHintBaseFlag}\` and re-run.`;
        return {
          ok: true,
          bundleKind: "needs_reconcile",
          selectedStrategy: "none",
          requiredReads: STRATEGY_REQUIRED_READS["none"],
          nextAction: reason,
          canonicalStateSummary: summarizeCanonicalState(bundle),
          bundle,
        };
      }
    } catch {
      return {
        ok: true,
        bundleKind: "needs_reconcile",
        selectedStrategy: "none",
        requiredReads: STRATEGY_REQUIRED_READS["none"],
        nextAction: "Local implementation requires worktree isolation but git worktree list failed. Verify the repository and re-run from a worktree under tmp/worktrees/.",
        canonicalStateSummary: summarizeCanonicalState(bundle),
        bundle,
      };
    }
  }
  return {
    ok: true,
    bundleKind: bundle.bundleKind,
    selectedStrategy: strategyKey,
    requiredReads: STRATEGY_REQUIRED_READS[strategyKey],
    nextAction: bundle.nextAction,
    canonicalStateSummary: summarizeCanonicalState(bundle),
    ...(planFileIntakeState !== null ? { planFileIntakeState } : {}),
    ...(spikeIntakeState !== null ? { spikeIntakeState } : {}),
    ...(canonicalSpecSource !== null ? { canonicalSpecSource } : {}),
    bundle,
  };
}
export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, adapter = createPiAdapter() } = {}) {
  const sessionCwd = adapter.getCwd();
  const options = parseResolveDevLoopStartupCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  // Resolve repo root via the adapter so the CLI stays harness-agnostic.
  const repoRoot = adapter.getRepoRoot();
  const { config: devLoopConfig, errors: configErrors = [] } = await loadDevLoopConfig({ repoRoot });
  const asyncStartMode = configErrors.length === 0
    ? resolveWorkflowConfig(devLoopConfig, "asyncStartMode")
    : "required";
  const targetPreference = configErrors.length === 0
    ? devLoopConfig?.strategy === "local-first"
      ? "prefer_local"
      : "prefer_github_first"
    : "prefer_local";
  const inputSource = configErrors.length === 0
    ? normalizeConfigInputSource(devLoopConfig?.inputSource)
    : "tracker";
  let input;
  if (options.spike !== undefined) {
    input = buildSpikeInput({ spikeFilePath: options.spike });
  } else if (options.planFile !== undefined) {
    input = buildPlanFileInput({ planFilePath: options.planFile });
  } else if (options.inputPath !== undefined) {
    const text = await readFile(path.resolve(options.inputPath), "utf8");
    const parsed = parseJsonText(text);
    // `--input` is untrusted external JSON. Strip the resolver-only intake fields
    // so it cannot inject them — `planFileExempt` would otherwise waive the
    // worktree-isolation guard for a normal local_implementation, and the intake
    // state is owned by the internal plan-file path (buildPlanFileInput), not the
    // caller.
    if (parsed && typeof parsed === "object") {
      delete parsed.planFileExempt;
      delete parsed.planFileIntakeState;
      delete parsed.spikeIntakeState;
      delete parsed.canonicalSpecSource;
    }
    input = parsed;
  } else if (options.issue !== undefined) {
    input = buildAutoResolvedInput({
      issue: options.issue,
      cwd: sessionCwd,
      targetPreference,
      inputSource,
      env: adapter.getEnv(),
    });
    // --lightweight modifier (issue #1025): the PR body becomes the
    // spec-of-record for this local session — no phase/plan doc minted.
    if (options.lightweight) {
      input = { ...input, canonicalSpecSource: "pr_body" };
    }
  } else if (options.lightweight) {
    // --lightweight used ALONE (no other mode flag): issue-less PR-first (#1210).
    // A broken config must surface as ITS OWN failure, not decay to the
    // misleading light_mode_disabled reason a bare {version:1} would produce.
    if (configErrors.length > 0) {
      throw new Error(`--lightweight without --issue (issue-less PR-first) requires a loadable dev-loop config, but config loading failed: ${configErrors.map((e) => e?.message ?? String(e)).join("; ")}. Fix the config or provide --issue <n>.`);
    }
    input = buildLightweightIssuelessInput({ config: devLoopConfig, cwd: repoRoot });
  } else {
    input = buildAutoResolvedInput({
      pr: options.pr,
      cwd: sessionCwd,
      targetPreference,
      uiReview: options.uiReview,
      env: adapter.getEnv(),
    });
  }
  const result = buildResolveDevLoopStartupResult(input, {
    asyncStartMode,
    adapter,
    config: configErrors.length === 0 ? devLoopConfig : undefined,
  });
  if (result.ok === false) {
    process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout: stderr, stderr });
    return;
  }
  // Emit the deterministic bundle FIRST, before the best-effort self-heal below,
  // so a slow or hung gh reconcile can never delay the startup result.
  process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
  // #1069: best-effort startup self-heal — converge the board from live GitHub
  // state so merged→Done / ready→In Progress land deterministically. Gated on a
  // configured board so it never shells out to gh in the no-.devloops unit tests;
  // never writes stdout, never changes exit code, never throws. Skips
  // --input/--plan-file/--spike modes.
  if (options.issue !== undefined || options.pr !== undefined) {
    let reconcileRoot = sessionCwd;
    try {
      reconcileRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: sessionCwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch { /* fall back to sessionCwd */ }
    if (loadBoardConfig(reconcileRoot).enabled === true) {
      try {
        // The budget bounds startup latency; reconcile is best-effort and the
        // board self-heals on the next entry if it doesn't finish. The timer is
        // unref'd so it never keeps the event loop alive on its own.
        await Promise.race([
          reconcileQueue({ repo: detectRepoSlug(reconcileRoot) }, { env: adapter.getEnv(), cwd: reconcileRoot, skipTerminalColumn: true }),
          new Promise((resolve) => { const t = setTimeout(resolve, STARTUP_RECONCILE_BUDGET_MS); t.unref?.(); }),
        ]);
      } catch { /* best-effort */ }
    }
  }
}
if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
