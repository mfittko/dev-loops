#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue, parsePositiveInteger } from "../_cli-primitives.mjs";
import { detectRepoSlug, normalizeRepoSlug } from "@dev-loops/core/github/repo-slug";
import { runContextEnv } from "@dev-loops/core/loop/run-context";
import { classifyBenignGateEvidenceUnstable } from "@dev-loops/core/loop/copilot-ci-status";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

// REPO_ROOT resolves to the git repo root (scripts/loop/info.mjs → scripts/ → repo/)
const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)), "..");

const USAGE = `Usage:
  dev-loops loop info --issue <number>
  dev-loops loop info --pr <number>
Read-only state inspection for issues and PRs.
Required (exactly one):
  --issue <n>    Issue number
  --pr <n>       PR number
Optional:
  --json         Machine-readable JSON output (default: human-readable summary)
  --repo <slug>  Repository slug (auto-detected from git remote when omitted)

${JQ_OUTPUT_USAGE}
(--jq/--silent only apply together with --json; the default text output is unaffected.)

Exit codes:
  0  Success
  1  Argument error or runtime failure
  2  Invalid --jq filter`.trim();

const parseError = buildParseError(USAGE);

function parseCliArgs(argv) {
  const opts = { help: false, issue: undefined, pr: undefined, json: false, repo: undefined };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      issue: { type: "string" },
      pr: { type: "string" },
      repo: { type: "string" },
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
    if (token.name === "help") { opts.help = true; return opts; }
    if (token.name === "json") { opts.json = true; continue; }
    if (token.name === "issue") { opts.issue = parsePositiveInteger(requireTokenValue(token, parseError), "--issue", parseError); continue; }
    if (token.name === "pr") { opts.pr = parsePositiveInteger(requireTokenValue(token, parseError), "--pr", parseError); continue; }
    if (token.name === "repo") { opts.repo = requireTokenValue(token, parseError); continue; }
    if (matchJqOutputToken(token, opts, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  const modes = [opts.issue, opts.pr].filter(v => v !== undefined).length;
  if (modes > 1) throw parseError("--issue and --pr are mutually exclusive");
  if (modes === 0) throw parseError("--issue <n> or --pr <n> is required");
  return opts;
}

function validateRepo(repo) {
  if (!repo) {
    throw parseError("Repo auto-detection failed. Set origin remote or use --repo.");
  }
  try {
    // Normalize (trim) the slug and validate structure
    return normalizeRepoSlug(repo, { errorMessage: "--repo must match <owner/name>" });
  } catch (err) {
    throw parseError(`Invalid repo slug: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function ghJson(args, cwd) {
  try {
    const stdout = execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`gh command failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function runNode(scriptPath, args, cwd) {
  const stdout = execFileSync(process.execPath, [scriptPath, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(stdout);
}

function formatBranchDisplay(headRefName, baseRefName) {
  return `${headRefName} ← ${baseRefName}`;
}

function formatCiDisplay(ciStatus, ciConclusion) {
  if (!ciStatus || ciStatus === "none") return "no CI";
  if (ciStatus === "pending") return "CI pending";
  if (ciStatus === "failure") return `CI ❌ (${ciConclusion || "failed"})`;
  if (ciStatus === "crediblyGreen") return "CI ✅ (local)";
  return `CI ${ciStatus}`;
}

/**
 * Project the branch rules that apply to the PR base (GET
 * repos/{repo}/rules/branches/{branch}) onto the observed check rollup.
 * Only repository rulesets are covered; classic branch protection required
 * checks are not read.
 * `rules` that are not an array mean the lookup failed: resolved is false.
 * A required check is missing when no rollup entry carries its name (CheckRun
 * `name` or StatusContext `context`); a reported one is pending or failed by
 * its entry state.
 */
export function summarizeBranchRules(rules, statusCheckRollup) {
  if (!Array.isArray(rules)) {
    return { resolved: false, missingRequiredChecks: [], pendingRequiredChecks: [], failedRequiredChecks: [], operatorApprovals: [] };
  }
  const rollup = (Array.isArray(statusCheckRollup) ? statusCheckRollup : []).filter((entry) => entry && typeof entry === "object");
  const required = rules
    .filter((rule) => rule?.type === "required_status_checks")
    .flatMap((rule) => Array.isArray(rule.parameters?.required_status_checks) ? rule.parameters.required_status_checks : [])
    .map((check) => check?.context)
    .filter((context) => typeof context === "string");
  const operatorApprovals = [];
  for (const rule of rules.filter((r) => r?.type === "pull_request")) {
    const count = rule.parameters?.required_approving_review_count ?? 0;
    if (count > 0) {
      operatorApprovals.push(`ruleset requires ${count} approving review(s)`);
    }
    if (rule.parameters?.require_extra_approval_for_unattributed_changes === true) {
      operatorApprovals.push("ruleset requires an extra approval for unattributed changes");
    }
  }
  const missingRequiredChecks = [];
  const pendingRequiredChecks = [];
  const failedRequiredChecks = [];
  for (const context of new Set(required)) {
    const entries = rollup.filter((entry) => entry.name === context || entry.context === context);
    if (entries.length === 0) missingRequiredChecks.push(context);
    else if (entries.some(isFailedCheck)) failedRequiredChecks.push(context);
    else if (entries.some(isPendingCheck)) pendingRequiredChecks.push(context);
  }
  return { resolved: true, missingRequiredChecks, pendingRequiredChecks, failedRequiredChecks, operatorApprovals };
}

// StatusContext entries carry `state`; CheckRun entries carry `status`/`conclusion`.
const FAILED_CHECK_RUN_CONCLUSIONS = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
function isFailedCheck(entry) {
  if (typeof entry.state === "string") return entry.state === "FAILURE" || entry.state === "ERROR";
  return FAILED_CHECK_RUN_CONCLUSIONS.has(entry.conclusion);
}
function isPendingCheck(entry) {
  if (typeof entry.state === "string") return entry.state === "PENDING" || entry.state === "EXPECTED";
  return entry.status !== "COMPLETED";
}

function formatMergeableDisplay(mergeable, mergeStateStatus, statusCheckRollup = null, branchRules = null, baseRefName = null) {
  const m = typeof mergeable === "string" ? mergeable.toUpperCase() : null;
  const s = typeof mergeStateStatus === "string" ? mergeStateStatus.toUpperCase() : null;
  if (m === "CONFLICTING" || s === "DIRTY" || s === "CONFLICTING") {
    return `❌ CONFLICTING${s ? ` (${s})` : ""} — resolve before any gate`;
  }
  if (s === "BEHIND") {
    return "⚠️ BEHIND — update branch from base before any gate";
  }
  if (m === "UNKNOWN") {
    return "⏳ UNKNOWN — GitHub still computing; recheck before proceeding";
  }
  // Fail closed: without the base ruleset, a required check may be absent.
  if (branchRules && !branchRules.resolved) {
    return `⚠️ INCOMPLETE — ruleset for ${baseRefName ?? "base"} unresolved; mergeability unknown`;
  }
  // BLOCKED is never mergeable: name what the ruleset projection knows.
  if (s === "BLOCKED") {
    const reasons = [];
    if (branchRules?.missingRequiredChecks.length > 0) reasons.push(`ruleset-required check(s) not reported: ${branchRules.missingRequiredChecks.join(", ")}`);
    if (branchRules?.pendingRequiredChecks.length > 0) reasons.push(`required check(s) pending: ${branchRules.pendingRequiredChecks.join(", ")}`);
    if (branchRules?.failedRequiredChecks.length > 0) reasons.push(`required check(s) failed: ${branchRules.failedRequiredChecks.join(", ")}`);
    reasons.push(...(branchRules?.operatorApprovals ?? []));
    return `⏳ BLOCKED — ${reasons.length > 0 ? reasons.join("; ") : "reason not projected"}`;
  }
  if (branchRules?.missingRequiredChecks.length > 0) {
    const missing = `⏳ BLOCKED${s ? ` (${s})` : ""} — ruleset-required check(s) not reported: ${branchRules.missingRequiredChecks.join(", ")}`;
    if (s !== "UNSTABLE") return missing;
    // A real failure beside the missing check must stay visible.
    const { benign, reason } = classifyBenignGateEvidenceUnstable(statusCheckRollup, mergeStateStatus);
    return benign ? missing : `${missing}; ${reason}; investigate before merge`;
  }
  // A benign UNSTABLE is the cosmetic rollup noise from superseded Gate-evidence
  // job cancellations (runner or reporter) while the required gate-evidence
  // status is itself green; do not mistake it for a real blocker. Render the
  // classifier's own reason so an unavailable rollup or an in-flight run reads
  // honestly instead of claiming a failing check is present.
  if (s === "UNSTABLE") {
    const { benign, reason } = classifyBenignGateEvidenceUnstable(statusCheckRollup, mergeStateStatus);
    if (benign) return `✅ MERGEABLE (UNSTABLE — benign: ${reason})`;
    return `⚠️ UNSTABLE — ${reason}; investigate before merge`;
  }
  if (m === "MERGEABLE") {
    return `✅ MERGEABLE${s ? ` (${s})` : ""}`;
  }
  return s || m || "unknown";
}

export function formatPrSummary(prData, handoffResult, branchRules = null) {
  const lines = [];
  lines.push(`PR #${prData.number}: ${prData.title}`);
  lines.push(`  Branch: ${formatBranchDisplay(prData.headRefName, prData.baseRefName)}`);
  lines.push(`  State: ${prData.state}${prData.isDraft ? " (draft)" : ""}`);
  lines.push(`  Author: ${prData.author?.login || "unknown"}`);
  lines.push(`  Mergeable: ${formatMergeableDisplay(prData.mergeable, prData.mergeStateStatus, prData.statusCheckRollup, branchRules, prData.baseRefName)}`);
  if (String(prData.mergeStateStatus).toUpperCase() === "BLOCKED") {
    for (const approval of branchRules?.operatorApprovals ?? []) {
      lines.push(`  Operator blocker: ${approval}`);
    }
  }
  const missingChecks = branchRules?.missingRequiredChecks ?? [];
  if (missingChecks.length > 0) {
    lines.push(`  Required checks: not reported at head: ${missingChecks.join(", ")}`);
  }

  if (handoffResult?.snapshot) {
    const s = handoffResult.snapshot;
    if (s.ciStatus !== undefined) {
      // Green observed checks never read as success while a required check is absent.
      const green = s.ciStatus === "success" || s.ciStatus === "crediblyGreen";
      lines.push(missingChecks.length > 0 && green
        ? `  CI: observed checks green; ruleset-required check(s) not reported: ${missingChecks.join(", ")}`
        : `  CI: ${formatCiDisplay(s.ciStatus, s.ciConclusion)}`);
    }
    if (s.unresolvedThreadCount !== undefined) {
      lines.push(`  Unresolved threads: ${s.unresolvedThreadCount}`);
    }
    if (s.completedCopilotRoundCount !== undefined && s.completedCopilotRoundCount > 0) {
      lines.push(`  Copilot rounds: ${s.completedCopilotRoundCount}`);
    }
    if (s.reviewRoundCount !== undefined && s.reviewRoundCount > 0) {
      lines.push(`  Review rounds: ${s.reviewRoundCount}`);
    }
    if (s.copilotReviewOnCurrentHead) {
      lines.push(`  Copilot review: requested on current head`);
    }
  } else if (handoffResult?.error) {
    lines.push(`  Handoff: unavailable (${handoffResult.error})`);
  }
  
  if (handoffResult?.action) {
    lines.push(`  Action: ${handoffResult.action}`);
  }
  if (handoffResult?.nextAction) {
    lines.push(`  Next: ${handoffResult.nextAction}`);
  }
  if (handoffResult?.state) {
    lines.push(`  Loop state: ${handoffResult.state}`);
  }
  const carried = handoffResult?.carriedConvergence;
  if (carried?.resolved === false) {
    lines.push(`  Copilot: re-request advice unverified against the requester (${carried.reason})`);
  } else if (carried) {
    lines.push(`  Copilot: re-request suppressed by the requester (${carried.source}: ${carried.reason})`);
  }

  return lines.join("\n");
}

function formatIssueSummary(issueData, startupBundle, linkedPrData) {
  const lines = [];
  lines.push(`Issue #${issueData.number}: ${issueData.title}`);
  lines.push(`  State: ${issueData.state}`);
  
  if (issueData.assignees?.length > 0) {
    const names = issueData.assignees.map(a => a.login).join(", ");
    lines.push(`  Assignees: ${names}`);
  }
  
  const bundle = startupBundle?.bundle || startupBundle;
  if (bundle) {
    if (bundle.loopState) lines.push(`  Loop state: ${bundle.loopState}`);
    if (bundle.selectedStrategy) lines.push(`  Strategy: ${bundle.selectedStrategy}`);
    if (bundle.routeKind) lines.push(`  Route: ${bundle.routeKind}`);
    if (bundle.nextAction) lines.push(`  Next: ${bundle.nextAction}`);
  } else if (startupBundle?.error) {
    lines.push(`  Startup: unavailable (${startupBundle.error})`);
  }
  
  if (issueData.body) {
    const hasAc = /##\s*Acceptance Criteria|##\s*AC\b|###\s*Acceptance Criteria|###\s*AC\b/i.test(issueData.body);
    lines.push(`  Acceptance criteria: ${hasAc ? "present" : "missing"}`);
  }
  
  if (linkedPrData) {
    lines.push(`  Linked PR: #${linkedPrData.number} (${linkedPrData.state}${linkedPrData.isDraft ? ", draft" : ""})`);
    if (linkedPrData.headRefName) {
      lines.push(`    Branch: ${formatBranchDisplay(linkedPrData.headRefName, linkedPrData.baseRefName)}`);
    }
    if (linkedPrData.ciStatus !== undefined) {
      lines.push(`    CI: ${formatCiDisplay(linkedPrData.ciStatus, linkedPrData.ciConclusion)}`);
    }
    if (linkedPrData.unresolvedThreadCount !== undefined) {
      lines.push(`    Unresolved threads: ${linkedPrData.unresolvedThreadCount}`);
    }
    if (linkedPrData.loopState) {
      lines.push(`    Loop state: ${linkedPrData.loopState}`);
    }
    if (linkedPrData.action) {
      lines.push(`    Action: ${linkedPrData.action}`);
    }
  }
  
  return lines.join("\n");
}

function buildPrInfo(prNumber, repo, cwd) {
  const prData = ghJson(["pr", "view", String(prNumber), "--repo", repo, "--json", "number,title,body,state,isDraft,headRefName,headRefOid,baseRefName,author,mergedAt,mergeable,mergeStateStatus,statusCheckRollup,url,reviewRequests"], cwd);
  
  let handoffResult = null;
  try {
    const handoffScript = path.join(REPO_ROOT, "scripts/loop/copilot-pr-handoff.mjs");
    handoffResult = runNode(handoffScript, ["--pr", String(prNumber), "--repo", repo, "--watch-status", "idle"], cwd);
  } catch (err) {
    handoffResult = { error: err instanceof Error ? err.message : String(err) };
  }

  // ponytail: one page of 100 rules; paginate if a base ever carries more.
  // A closed or merged PR has no mergeability to project.
  let branchRules = null;
  if (prData.state === "OPEN") {
    let rules = null;
    try {
      if (prData.baseRefName) {
        const branch = prData.baseRefName.split("/").map(encodeURIComponent).join("/");
        rules = ghJson(["api", `repos/${repo}/rules/branches/${branch}?per_page=100`], cwd);
      }
    } catch {
      rules = null;
    }
    branchRules = summarizeBranchRules(rules, prData.statusCheckRollup);
  }

  return { prData, handoffResult, branchRules };
}

function buildIssueInfo(issueNumber, repo, cwd) {
  const issueData = ghJson(["issue", "view", String(issueNumber), "--repo", repo, "--json", "number,title,body,state,labels,assignees,milestone,url"], cwd);
  
  // Run startup resolver with a synthetic neutral run id to avoid
  // async-start contract rejection for GitHub-first issue routes.
  let startupBundle = null;
  try {
    const startupScript = path.join(REPO_ROOT, "scripts/loop/resolve-dev-loop-startup.mjs");
    // info.mjs only previews routing (read-only); it never starts or claims
    // anything, so it opts out of the single-contributor ownership gate —
    // otherwise this preview would fail closed for any issue the
    // viewer hasn't claimed yet.
    const env = { ...process.env, ...runContextEnv("info-readonly-placeholder"), DEVLOOPS_OWNERSHIP_BYPASS: "1" };
    const raw = execFileSync(process.execPath, [startupScript, "--issue", String(issueNumber)], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env,
    });
    startupBundle = JSON.parse(raw);
  } catch (err) {
    startupBundle = { error: err instanceof Error ? err.message : String(err) };
  }
  
  let linkedPrInfo = null;
  try {
    const linkageScript = path.join(REPO_ROOT, "scripts/github/detect-linked-issue-pr.mjs");
    const linkage = runNode(linkageScript, ["--repo", repo, "--issue", String(issueNumber)], cwd);
    if (linkage.hasOpenLinkedPr && linkage.prNumber) {
      const prData = ghJson(["pr", "view", String(linkage.prNumber), "--repo", repo, "--json", "number,title,state,isDraft,headRefName,baseRefName,author,url"], cwd);
      
      let handoffResult = null;
      try {
        const handoffScript = path.join(REPO_ROOT, "scripts/loop/copilot-pr-handoff.mjs");
        handoffResult = runNode(handoffScript, ["--pr", String(linkage.prNumber), "--repo", repo, "--watch-status", "idle"], cwd);
      } catch {
        handoffResult = null;
      }
      
      linkedPrInfo = {
        ...prData,
        ciStatus: handoffResult?.snapshot?.ciStatus,
        ciConclusion: handoffResult?.snapshot?.ciConclusion,
        unresolvedThreadCount: handoffResult?.snapshot?.unresolvedThreadCount,
        loopState: handoffResult?.state,
        action: handoffResult?.action,
      };
    }
  } catch {
    // Linked PR detection unavailable
  }
  
  return { issueData, startupBundle, linkedPrInfo: linkedPrInfo };
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const opts = parseCliArgs(argv);
  if (opts.help) { stdout.write(`${USAGE}\n`); return; }
  
  const cwd = process.cwd();
  const rawRepo = opts.repo || detectRepoSlug(cwd);
  // validateRepo normalizes (trims) the slug
  const repo = validateRepo(rawRepo);
  
  if (opts.issue !== undefined) {
    const { issueData, startupBundle, linkedPrInfo } = buildIssueInfo(opts.issue, repo, cwd);
    
    if (opts.json) {
      process.exitCode = emitResult({ ok: true, kind: "issue", issue: issueData, startup: startupBundle, linkedPr: linkedPrInfo }, { jq: opts.jq, silent: opts.silent, stdout, stderr });
    } else {
      stdout.write(formatIssueSummary(issueData, startupBundle, linkedPrInfo) + "\n");
    }
  } else {
    const { prData, handoffResult, branchRules } = buildPrInfo(opts.pr, repo, cwd);

    if (opts.json) {
      process.exitCode = emitResult({ ok: true, kind: "pr", pr: prData, handoff: handoffResult, branchRules }, { jq: opts.jq, silent: opts.silent, stdout, stderr });
    } else {
      stdout.write(formatPrSummary(prData, handoffResult, branchRules) + "\n");
    }
  }
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
