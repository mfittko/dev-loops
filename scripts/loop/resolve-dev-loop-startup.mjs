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
import { loadDevLoopConfig, resolveWorkflowConfig } from "@dev-loops/core/config";
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
Exit codes:
  0  Success
  1  Argument error, runtime failure, or async-start contract rejection`.trim();
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
  none: false,
};
const parseError = buildParseError(USAGE);
export function parseResolveDevLoopStartupCliArgs(argv) {
  const options = {
    help: false,
    inputPath: undefined,
    issue: undefined,
    pr: undefined,
    planFile: undefined,
    spike: undefined,
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
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  const modeCount = [options.inputPath, options.issue, options.pr, options.planFile, options.spike].filter(v => v !== undefined).length;
  if (modeCount > 1) {
    throw parseError("--issue, --pr, --input, --plan-file, and --spike are mutually exclusive; provide exactly one");
  }
  if (modeCount === 0) {
    throw parseError("--input <path>, --issue <n>, --pr <n>, --plan-file <path>, or --spike <path> is required");
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
        val = JSON.parse(raw)?.strategy?.default;
      } else if (devloopsPath.endsWith(".yaml") || devloopsPath.endsWith(".yml")) {
        const m = raw.match(/strategy:\s*\n\s*default:\s*["']?([^"'\s]+)["']?/);
        val = m ? m[1] : undefined;
      } else {
        // Bare file (no recognized extension) — YAML first, JSON fallback
        const m = raw.match(/strategy:\s*\n\s*default:\s*["']?([^"'\s]+)["']?/);
        if (m) {
          val = m[1];
        } else {
          try {
            val = JSON.parse(raw)?.strategy?.default;
          } catch {
            // Not valid JSON either — fall through
          }
        }
      }
      if (val === "local-first") return "prefer_local";
      if (val === "github-first") return "prefer_github_first";
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
        const val = parsed?.strategy?.default;
        if (val === "local-first") return "prefer_local";
        if (val === "github-first") return "prefer_github_first";
        continue;
      }
      const match = raw.match(/strategy:\s*\n\s*default:\s*["']?([^"'\s]+)["']?/);
      if (match) {
        if (match[1] === "local-first") return "prefer_local";
        if (match[1] === "github-first") return "prefer_github_first";
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
export function buildAutoResolvedInput({ issue, pr, cwd, targetPreference, inputSource }) {
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
    try {
      const linkageJson = execFileSync(process.execPath, [
        path.join(repoRoot, "scripts/github/detect-linked-issue-pr.mjs"),
        "--repo", repo, "--issue", String(issue),
      ], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const linkage = JSON.parse(linkageJson);
      if (linkage.hasOpenLinkedPr) {
        issueLinkageResolution = "resolved_linked_pr";
        linkedPr = linkage.prNumber;
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
    } catch {
      warnings.push(`issueLinkageResolution: using default "${issueLinkageResolution}" — linked-PR detection unavailable`);
    }
    let issueReadiness;
    try {
      const issueJson = ghJson(["issue", "view", String(issue), "--repo", repo, "--json", "body"], repoRoot);
      issueReadiness = hasAcSection(issueJson.body) ? "ready" : "needs_clarification";
    } catch {
      issueReadiness = "needs_clarification";
      warnings.push(`issueReadiness: using default "${issueReadiness}" — gh issue view failed`);
    }
    let issueAssignmentState;
    try {
      const assigneesJson = ghJson(["issue", "view", String(issue), "--repo", repo, "--json", "assignees"], repoRoot);
      issueAssignmentState = (assigneesJson.assignees || []).some(a => a.login === "copilot-swe-agent")
        ? "assigned_to_copilot"
        : "unassigned";
    } catch {
      issueAssignmentState = "unassigned";
      warnings.push(`issueAssignmentState: using default "${issueAssignmentState}" — gh issue view failed`);
    }
    const loopState = "issue_intake_start";
    return {
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
  }
  let artifactState;
  try {
    const prJson = ghJson(["pr", "view", String(pr), "--repo", repo, "--json", "state,mergedAt"], repoRoot);
    artifactState = prJson.mergedAt ? "merged" : mapGhState(prJson.state);
  } catch {
    artifactState = "open";
  }
  const resolvedTargetPreference = targetPreference ?? resolveTargetPreference(repoRoot);
  return {
    intent: "continue_on_pr",
    mode: "bounded_handoff",
    targetPreference: resolvedTargetPreference,
    artifactState,
    issueLinkageResolution: "not_applicable",
    loopState: "pr_followup_start",
    currentState: {
      target: { kind: "pr", issue: null, pr, linkedPr: null, branch: null, phase: null },
      ownership: "copilot",
      nextActor: "user",
      status: "active",
      authorization: "authorized",
    },
  };
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
export function buildResolveDevLoopStartupResult(input, { adapter = createPiAdapter(), env, cwd, asyncStartMode = "required" } = {}) {
  const effectiveEnv = env ?? adapter.getEnv();
  const effectiveCwd = cwd ?? adapter.getCwd();
  // Normalize a non-object input (e.g. `--input null`, which parses to a legal
  // JSON null) to {} so the destructure below cannot throw before routing can
  // fail closed with a structured reconcile bundle.
  if (input === null || typeof input !== "object") input = {};
  // Plan-file intake carries two resolver-only fields that the pure routing
  // evaluator does not model. Strip them before evaluation and re-apply them to
  // the result; `planFileExempt` waives the worktree-isolation guard because a
  // pre-promotion plan has no issue to key a worktree on.
  const { planFileExempt = false, planFileIntakeState = null, spikeIntakeState = null, ...routingInput } = input;
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
          ? `Local implementation requires worktree isolation. Current directory is the main git checkout (${mainPath}). Run \`node scripts/loop/ensure-worktree.mjs --repo-root ${mainPath} --issue <n>\` to create+provision the worktree under tmp/worktrees/dev-loops/<kind>-<n>, then re-run from there.`
          : "Local implementation requires worktree isolation. Current directory is not under tmp/worktrees/. Run `node scripts/loop/ensure-worktree.mjs --repo-root <main> --issue <n>` to create+provision a worktree under tmp/worktrees/dev-loops/<kind>-<n>, then re-run from there.";
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
        const reason = `Local implementation requires worktree isolation. Current directory is under tmp/worktrees/ but is not listed as a git worktree by \`git worktree list\`. Create a proper worktree with \`node scripts/loop/ensure-worktree.mjs --repo-root <main> --issue <n>\` and re-run.`;
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
    ? devLoopConfig?.strategy?.default === "local-first"
      ? "prefer_local"
      : "prefer_github_first"
    : "prefer_local";
  const inputSource = configErrors.length === 0
    ? normalizeConfigInputSource(devLoopConfig?.inputSource?.default)
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
    }
    input = parsed;
  } else if (options.issue !== undefined) {
    input = buildAutoResolvedInput({
      issue: options.issue,
      cwd: sessionCwd,
      targetPreference,
      inputSource,
    });
  } else {
    input = buildAutoResolvedInput({
      pr: options.pr,
      cwd: sessionCwd,
      targetPreference,
    });
  }
  const result = buildResolveDevLoopStartupResult(input, { asyncStartMode, adapter });
  if (result.ok === false) {
    stderr.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
    return;
  }
  // Emit the deterministic bundle FIRST, before the best-effort self-heal below,
  // so a slow or hung gh reconcile can never delay the startup result.
  stdout.write(`${JSON.stringify(result)}\n`);
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
          reconcileQueue({ repo: detectRepoSlug(reconcileRoot) }, { env: adapter.getEnv(), cwd: reconcileRoot }),
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
