#!/usr/bin/env node
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue, runCommand } from "../_cli-primitives.mjs";
import { parseArgs } from "node:util";
import {
  isUnderWorktreePath, parseMainWorktreePath, isMainCheckout,
} from "@dev-loops/core/loop/worktree-guard";

const USAGE = `Usage:
  pre-commit-branch-guard.mjs --expected-branch <name> [--require-worktree] [--block-main-checkout]

Verify the current git branch identity and/or worktree isolation before local commit steps.`;

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
    throw parseError(`Unknown argument: ${token.rawName}`);
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
