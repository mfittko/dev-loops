#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveAuthoritativeStartupResumeBundle } from "../../packages/core/src/loop/public-dev-loop-routing.mjs";
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { requireOptionValue, parsePositiveInteger } from "../_cli-primitives.mjs";
import { execFileSync } from "node:child_process";
import {
  isUnderWorktreePath,
  parseMainWorktreePath,
  isMainCheckout,
  parseAllWorktreePaths,
  isListedWorktree,
} from "../../packages/core/src/loop/worktree-guard.mjs";
import {
  validateAsyncStartContext,
  buildAsyncStartRejection,
  ASYNC_START_STATUS,
} from "../../packages/core/src/loop/async-start-contract.mjs";
import { detectRepoSlug } from "@pi-dev-loops/core/github/repo-slug";
import { isCopilotLogin } from "@pi-dev-loops/core/github/copilot-helpers";
import { loadDevLoopConfig, resolveWorkflowConfig } from "../../packages/core/src/config/config.mjs";
import { createPiAdapter } from "@pi-dev-loops/core/harness";
const USAGE = `Usage:
  resolve-dev-loop-startup.mjs --issue <number>
  resolve-dev-loop-startup.mjs --pr <number>
  resolve-dev-loop-startup.mjs --input <path>
Resolve the authoritative public dev-loop startup/resume bundle.
Auto-resolves state from GitHub API, git remote, and settings when
--issue or --pr is used. Use --input for non-standard states.
Required (exactly one):
  --issue <n>    Target an issue by number (auto-resolves all state)
  --pr <n>       Target a PR by number (auto-resolves all state)
  --input <path>  Path to a JSON file with canonical-state payload
Exit codes:
  0  Success
  1  Argument error, runtime failure, or async-start contract rejection`.trim();
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
  const args = [...argv];
  const options = {
    help: false,
    inputPath: undefined,
    issue: undefined,
    pr: undefined,
  };
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--help" || token === "-h") {
      options.help = true;
      return options;
    }
    if (token === "--input") {
      options.inputPath = requireOptionValue(args, "--input", parseError);
      continue;
    }
    if (token === "--issue") {
      options.issue = parsePositiveInteger(requireOptionValue(args, "--issue", parseError), "--issue", parseError);
      continue;
    }
    if (token === "--pr") {
      options.pr = parsePositiveInteger(requireOptionValue(args, "--pr", parseError), "--pr", parseError);
      continue;
    }
    throw parseError(`Unknown argument: ${token}`);
  }
  const modeCount = [options.inputPath, options.issue, options.pr].filter(v => v !== undefined).length;
  if (modeCount > 1) {
    throw parseError("--issue, --pr, and --input are mutually exclusive; provide exactly one");
  }
  if (modeCount === 0) {
    throw parseError("--input <path>, --issue <n>, or --pr <n> is required");
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
  return "prefer_github_first";
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
    const validation = validateAsyncStartContext({ env: effectiveEnv, asyncStartMode });
    if (validation.status === ASYNC_START_STATUS.REJECTED) {
      return buildAsyncStartRejection(validation);
    }
  }
  const PI_WORKTREE_BYPASS_VAR = "PI_WORKTREE_BYPASS";
  if (
    strategyKey === "local_implementation" &&
    (effectiveEnv[PI_WORKTREE_BYPASS_VAR] ?? "").trim() !== "1"
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
          ? `Local implementation requires worktree isolation. Current directory is the main git checkout (${mainPath}). Create a worktree under tmp/worktrees/<slug>/ and re-run.`
          : "Local implementation requires worktree isolation. Current directory is not under tmp/worktrees/. Create a worktree and re-run.";
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
        const reason = `Local implementation requires worktree isolation. Current directory is under tmp/worktrees/ but is not listed as a git worktree by \`git worktree list\`. Create a proper worktree with \`git worktree add\` and re-run.`;
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
  // Resolve repo root to handle subdirectory invocations consistently.
  // buildAutoResolvedInput() also resolves via git rev-parse;
  // using the same root for config loading avoids mismatched roots.
  let repoRoot = sessionCwd;
  try {
    repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: sessionCwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { /* keep cwd */ }
  const { config: devLoopConfig, errors: configErrors = [] } = await loadDevLoopConfig({ repoRoot });
  const asyncStartMode = configErrors.length === 0
    ? resolveWorkflowConfig(devLoopConfig, "asyncStartMode")
    : "required";
  const targetPreference = configErrors.length === 0
    ? devLoopConfig?.strategy?.default === "local-first"
      ? "prefer_local"
      : "prefer_github_first"
    : "prefer_github_first";
  const inputSource = configErrors.length === 0
    ? normalizeConfigInputSource(devLoopConfig?.inputSource?.default)
    : "tracker";
  let input;
  if (options.inputPath !== undefined) {
    const text = await readFile(path.resolve(options.inputPath), "utf8");
    input = parseJsonText(text);
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
  stdout.write(`${JSON.stringify(result)}\n`);
}
if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
