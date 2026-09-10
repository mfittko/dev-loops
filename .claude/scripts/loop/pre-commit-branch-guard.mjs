#!/usr/bin/env node
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue, runCommand } from "../_cli-primitives.mjs";
import { parseArgs } from "node:util";
import {
  isUnderWorktreePath, parseMainWorktreePath, isMainCheckout,
} from "@dev-loops/core/loop/worktree-guard";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage:
  pre-commit-branch-guard.mjs --expected-branch <name> [--require-worktree] [--block-main-checkout]

Verify the current git branch identity and/or worktree isolation before local commit steps.

${JQ_OUTPUT_USAGE}`;

const parseError = buildParseError(USAGE);

export function parseBranchGuardCliArgs(argv) {
  const options = { help: false, expectedBranch: undefined, requireWorktree: false, blockMainCheckout: false };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      "expected-branch": { type: "string" },
      "require-worktree": { type: "boolean" },
      "block-main-checkout": { type: "boolean" },
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
    if (token.name === "help") { options.help = true; return options; }
    if (token.name === "expected-branch") { options.expectedBranch = requireTokenValue(token, parseError, { flagPattern: /^-/u }); continue; }
    if (token.name === "require-worktree") { options.requireWorktree = true; continue; }
    if (token.name === "block-main-checkout") { options.blockMainCheckout = true; continue; }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.expectedBranch === undefined) { throw parseError("--expected-branch <name> is required"); }
  return options;
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, cwd = process.cwd(), env = process.env, gitCommand = "git" } = {}) {
  const options = parseBranchGuardCliArgs(argv);
  if (options.help) { stdout.write(`${USAGE}\n`); return { ok: true, help: true }; }

  const emit = (payload, target) => {
    process.exitCode = emitResult(payload, { jq: options.jq, silent: options.silent, stdout: target, stderr });
    return payload;
  };

  const { stdout: branchOutput } = await runCommand(gitCommand, ["branch", "--show-current"], { cwd, env });
  const currentBranch = branchOutput.trim();
  if (currentBranch !== options.expectedBranch) {
    return emit({ ok: false, error: "branch_mismatch", current: currentBranch, expected: options.expectedBranch }, stderr);
  }

  let worktreeOk = null, mainCheckoutBlocked = null;
  if (options.requireWorktree || options.blockMainCheckout) {
    let mainWorktreePath = null;
    if (options.blockMainCheckout) {
      try { const { stdout: wtOutput } = await runCommand(gitCommand, ["worktree", "list"], { cwd, env }); mainWorktreePath = parseMainWorktreePath(wtOutput); } catch {}
    }
    if (options.requireWorktree) {
      worktreeOk = isUnderWorktreePath(cwd);
      if (!worktreeOk) { return emit({ ok: false, error: "not_in_worktree", cwd, requiredPrefix: "tmp/worktrees/" }, stderr); }
    }
    if (options.blockMainCheckout) {
      const isMain = isMainCheckout(cwd, mainWorktreePath);
      mainCheckoutBlocked = !(isMain && !isUnderWorktreePath(cwd));
      if (!mainCheckoutBlocked) { return emit({ ok: false, error: "main_checkout_blocked", cwd, mainWorktree: mainWorktreePath }, stderr); }
    }
    if (!options.requireWorktree) worktreeOk = null;
    if (!options.blockMainCheckout) mainCheckoutBlocked = null;
  }

  return emit({ ok: true, branch: currentBranch, matched: true, worktreeOk, mainCheckoutBlocked }, stdout);
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => { process.stderr.write(`${formatCliError(error)}\n`); process.exitCode = 1; });
}
