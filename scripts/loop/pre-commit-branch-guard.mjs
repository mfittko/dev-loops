#!/usr/bin/env node
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireOptionValue, runCommand } from "../_cli-primitives.mjs";
import {
  isUnderWorktreePath, parseMainWorktreePath, isMainCheckout,
} from "@dev-loops/core/loop/worktree-guard";

const USAGE = `Usage:
  pre-commit-branch-guard.mjs --expected-branch <name> [--require-worktree] [--block-main-checkout]

Verify the current git branch identity and/or worktree isolation before local commit steps.`;

const parseError = buildParseError(USAGE);

export function parseBranchGuardCliArgs(argv) {
  const args = [...argv];
  const options = { help: false, expectedBranch: undefined, requireWorktree: false, blockMainCheckout: false };
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--help" || token === "-h") { options.help = true; return options; }
    if (token === "--expected-branch") { options.expectedBranch = requireOptionValue(args, "--expected-branch", parseError, { flagPattern: /^-/u }); continue; }
    if (token === "--require-worktree") { options.requireWorktree = true; continue; }
    if (token === "--block-main-checkout") { options.blockMainCheckout = true; continue; }
    throw parseError(`Unknown argument: ${token}`);
  }
  if (options.expectedBranch === undefined) { throw parseError("--expected-branch <name> is required"); }
  return options;
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, cwd = process.cwd(), env = process.env, gitCommand = "git" } = {}) {
  const options = parseBranchGuardCliArgs(argv);
  if (options.help) { stdout.write(`${USAGE}\n`); return { ok: true, help: true }; }

  const { stdout: branchOutput } = await runCommand(gitCommand, ["branch", "--show-current"], { cwd, env });
  const currentBranch = branchOutput.trim();
  if (currentBranch !== options.expectedBranch) {
    const payload = { ok: false, error: "branch_mismatch", current: currentBranch, expected: options.expectedBranch };
    stderr.write(`${JSON.stringify(payload)}\n`);
    return payload;
  }

  let worktreeOk = null, mainCheckoutBlocked = null;
  if (options.requireWorktree || options.blockMainCheckout) {
    let mainWorktreePath = null;
    if (options.blockMainCheckout) {
      try { const { stdout: wtOutput } = await runCommand(gitCommand, ["worktree", "list"], { cwd, env }); mainWorktreePath = parseMainWorktreePath(wtOutput); } catch {}
    }
    if (options.requireWorktree) {
      worktreeOk = isUnderWorktreePath(cwd);
      if (!worktreeOk) { stderr.write(JSON.stringify({ ok: false, error: "not_in_worktree", cwd, requiredPrefix: "tmp/worktrees/" }) + "\n"); return { ok: false, error: "not_in_worktree" }; }
    }
    if (options.blockMainCheckout) {
      const isMain = isMainCheckout(cwd, mainWorktreePath);
      mainCheckoutBlocked = !(isMain && !isUnderWorktreePath(cwd));
      if (!mainCheckoutBlocked) { stderr.write(JSON.stringify({ ok: false, error: "main_checkout_blocked", cwd, mainWorktree: mainWorktreePath }) + "\n"); return { ok: false, error: "main_checkout_blocked" }; }
    }
    if (!options.requireWorktree) worktreeOk = null;
    if (!options.blockMainCheckout) mainCheckoutBlocked = null;
  }

  const payload = { ok: true, branch: currentBranch, matched: true, worktreeOk, mainCheckoutBlocked };
  stdout.write(`${JSON.stringify(payload)}\n`);
  return payload;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().then((result) => { if (result?.ok === false) { process.exitCode = 1; } }).catch((error) => { process.stderr.write(`${formatCliError(error)}\n`); process.exitCode = 1; });
}
