#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { createPiAdapter } from "@dev-loops/core/harness";
import { parseArgs } from "node:util";
import {
  isUnderWorktreePath,
  parseMainWorktreePath,
  isMainCheckout,
  parseAllWorktreePaths,
  isListedWorktree,
  isWorktreeCoreIsolated,
  detectSubagentAvailability,
} from "@dev-loops/core/loop/worktree-guard";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
const DEVLOOPS_PREFLIGHT_BYPASS_VAR = "DEVLOOPS_PREFLIGHT_BYPASS";
const USAGE = `Usage:
  pre-flight-gate.mjs [--expected-branch <name>] [--check-subagents]
Gate local implementation mutations before planning or editing.
Required environment:
  (none)
Optional:
  --expected-branch <name>   Expected current branch (for branch identity check).
  --check-subagents        Check subagent availability (advisory; fails-open).
Success output (stdout, JSON):
  { "ok": true, "checks": { "worktree": true, "branch": "matched",
    "subagents": "available" } }
Violation output (stderr, JSON, exit 1):
  { "ok": false, "error": "<error_code>", "checks": { ... },
    "guidance": "<actionable instruction for the agent>" }
Bypass:
  DEVLOOPS_PREFLIGHT_BYPASS=1   Skip all checks (for development/testing only).

${JQ_OUTPUT_USAGE}`.trim();
const parseError = buildParseError(USAGE);
export function parsePreFlightGateCliArgs(argv) {
  const options = {
    help: false,
    expectedBranch: undefined,
    checkSubagents: false,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      "expected-branch": { type: "string" },
      "check-subagents": { type: "boolean" },
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
    if (token.name === "expected-branch") {
      options.expectedBranch = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (token.name === "check-subagents") {
      options.checkSubagents = true;
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  return options;
}
function checkWorktreeIsolation({ cwd, env, gitCommand = "git" }) {
  let worktreeListOutput;
  try {
    worktreeListOutput = execFileSync(gitCommand, ["worktree", "list"], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return {
      ok: false,
      error: "worktree_list_failed",
      guidance: "Could not run `git worktree list`. Verify the repository is a valid git working directory.",
    };
  }
  const mainWorktreePath = parseMainWorktreePath(worktreeListOutput);
  if (!isUnderWorktreePath(cwd)) {
    if (mainWorktreePath !== null && isMainCheckout(cwd, mainWorktreePath)) {
      return {
        ok: false,
        error: "main_checkout_detected",
        guidance:
          `Current directory appears to be the main git checkout (${mainWorktreePath}).\n` +
          "Local implementation requires worktree isolation. Create a worktree:\n" +
          "  node scripts/loop/ensure-worktree.mjs --repo-root <main> --issue <n>\n" +
          "  (creates+provisions tmp/worktrees/dev-loops/<kind>-<n> from origin/main)\n" +
          "Then re-run from the worktree directory.",
        mainWorktreePath,
      };
    }
    return {
      ok: false,
      error: "not_in_worktree",
      guidance:
        "Local implementation requires worktree isolation. Create a worktree:\n" +
        "  node scripts/loop/ensure-worktree.mjs --repo-root <main> --issue <n>\n" +
        "  (creates+provisions tmp/worktrees/dev-loops/<kind>-<n> from origin/main)\n" +
        "Then re-run from the worktree directory.",
      mainWorktreePath: mainWorktreePath ?? undefined,
    };
  }
  const allPaths = parseAllWorktreePaths(worktreeListOutput);
  if (!isListedWorktree(cwd, allPaths)) {
    return {
      ok: false,
      error: "not_in_worktree",
      guidance:
        "Current directory is under tmp/worktrees/ but is not a real git worktree.\n" +
        "Create a worktree with:\n" +
        "  node scripts/loop/ensure-worktree.mjs --repo-root <main> --issue <n>\n" +
        "  (creates+provisions tmp/worktrees/dev-loops/<kind>-<n> from origin/main)\n" +
        "Then re-run from the worktree directory.",
      mainWorktreePath: mainWorktreePath ?? undefined,
    };
  }
  if (!isWorktreeCoreIsolated(cwd, allPaths)) {
    return {
      ok: false,
      error: "core_link_escapes",
      guidance:
        "Worktree isolation violation: node_modules/@dev-loops/core resolves OUTSIDE this worktree's own packages/core (WORKTREE-DEPS-ISOLATED / WORKTREE-CREATE-PROVISION). " +
        "A worktree must resolve its own packages/core, not the main checkout's. Re-provision the worktree with:\n" +
        "  node scripts/loop/ensure-worktree.mjs --repo-root <main> --issue <n>\n" +
        "Then re-run from the worktree directory.",
      mainWorktreePath: mainWorktreePath ?? undefined,
    };
  }
  return { ok: true, mainWorktreePath: mainWorktreePath ?? undefined };
}
function checkBranchIdentity({ cwd, env, expectedBranch, gitCommand = "git" }) {
  if (!expectedBranch) {
    return { ok: true, status: "skipped" };
  }
  let currentBranch;
  try {
    currentBranch = execFileSync(gitCommand, ["branch", "--show-current"], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return {
      ok: false,
      status: "error",
      error: "branch_check_failed",
      guidance: "Could not determine current branch. Verify the repository is a valid git working directory.",
    };
  }
  if (currentBranch !== expectedBranch) {
    return {
      ok: false,
      status: "mismatch",
      error: "branch_mismatch",
      guidance: `Expected branch "${expectedBranch}" but current branch is "${currentBranch}". Switch to the working branch and re-run.`,
    };
  }
  return { ok: true, status: "matched", branch: currentBranch };
}
function checkSubagentAvailability({ env, checkSubagents }) {
  if (!checkSubagents) {
    return { ok: true, status: "skipped" };
  }
  const available = detectSubagentAvailability({ env });
  return { ok: true, status: available ? "available" : "unavailable" };
}
export async function runCli(
  argv = process.argv.slice(2),
  {
    stdout = process.stdout,
    stderr = process.stderr,
    adapter = createPiAdapter(),
    cwd,
    env,
    gitCommand = "git",
  } = {},
) {
  const effectiveCwd = cwd ?? adapter.getCwd();
  const effectiveEnv = env ?? adapter.getEnv();
  const options = parsePreFlightGateCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return { ok: true, help: true };
  }
  if ((effectiveEnv[DEVLOOPS_PREFLIGHT_BYPASS_VAR] ?? "").trim() === "1") {
    const payload = {
      ok: true,
      checks: { worktree: true, branch: "skipped", subagents: "skipped" },
      summary: "pre-flight gate bypassed via DEVLOOPS_PREFLIGHT_BYPASS=1",
    };
    process.exitCode = emitResult(payload, { jq: options.jq, silent: options.silent, stdout, stderr });
    return payload;
  }
  const checks = { worktree: false, branch: "skipped", subagents: "skipped" };
  const errors = [];
  const worktreeResult = checkWorktreeIsolation({ cwd: effectiveCwd, env: effectiveEnv, gitCommand });
  checks.worktree = worktreeResult.ok;
  if (!worktreeResult.ok) {
    errors.push({
      check: "worktree",
      error: worktreeResult.error,
      guidance: worktreeResult.guidance,
    });
  }
  const branchResult = checkBranchIdentity({
    cwd: effectiveCwd,
    env: effectiveEnv,
    expectedBranch: options.expectedBranch,
    gitCommand,
  });
  checks.branch = branchResult.status;
  if (!branchResult.ok) {
    errors.push({
      check: "branch",
      error: branchResult.error,
      guidance: branchResult.guidance,
    });
  }
  const subagentResult = checkSubagentAvailability({
    env: effectiveEnv,
    checkSubagents: options.checkSubagents,
  });
  checks.subagents = subagentResult.status;
  if (errors.length > 0) {
    const payload = {
      ok: false,
      error: errors[0].error,
      checks,
      guidance: errors.map((e) => e.guidance).join("\n\n"),
      errors,
    };
    process.exitCode = emitResult(payload, { jq: options.jq, silent: options.silent, stdout: stderr, stderr });
    return payload;
  }
  const payload = {
    ok: true,
    checks,
    summary: "all checks passed",
  };
  process.exitCode = emitResult(payload, { jq: options.jq, silent: options.silent, stdout, stderr });
  return payload;
}
if (isDirectCliRun(import.meta.url)) {
  runCli()
    .catch((error) => {
      process.stderr.write(`${formatCliError(error)}\n`);
      process.exitCode = 1;
    });
}
