#!/usr/bin/env node
/**
 * PostToolUse Bash post-merge hook (#773, #1596).
 *
 * The Pi extension runs `pi update git:...` after a merge to self-update the installed package;
 * under Claude Code plugin updates flow through the marketplace (#774), so that deferred-at-end
 * action is a no-op here. There IS, however, a shared best-effort action both harnesses need:
 * fast-forward the main checkout's local `main` to `origin/main` (#1596). The dev-loop merges
 * remotely (`gh pr merge` → origin/main) but never fast-forwarded the main checkout, so
 * read-only gate scripts (probe-ci-status.mjs, detect-copilot-loop-state.mjs, …) run from the
 * main checkout on stale code — re-introducing the CI-wait stall every PR. This hook resolves
 * the main (primary) checkout via `git worktree list` and runs a best-effort `--ff-only`
 * fast-forward there. Never blocks (always `process.exit(0)`); `--ff-only` refuses a diverged
 * main without rewriting history, so a diverged checkout warns and continues.
 */
import { execFileSync, execSync } from "node:child_process";
import { isMergeCapableCommand, extractPrNumberFromGhPrMergeAnywhere } from "./_bash-command-classify.mjs";
import { parseMainWorktreePath } from "./_worktree-guard.mjs";
import { buildMainCheckoutFastForwardCommand, WORKTREE_CLEANUP_TIMEOUT_MS, MAIN_CHECKOUT_FF_FETCH_TIMEOUT_MS, MAIN_CHECKOUT_FF_MERGE_TIMEOUT_MS, buildWorktreeCleanupCommand } from "./_main-checkout-ff.mjs";

import { readHookInput } from "./_hook-io.mjs";

const input = readHookInput();
const command = input?.tool_input?.command;
if (typeof command === "string" && isMergeCapableCommand(command)) {
  const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  let mainCheckout = null;
  try {
    const list = execFileSync("git", ["worktree", "list"], { cwd, encoding: "utf8", timeout: MAIN_CHECKOUT_FF_FETCH_TIMEOUT_MS });
    mainCheckout = parseMainWorktreePath(list);
  } catch {
    // Not a git repo / git unavailable — mainCheckout stays null.
  }

  if (!mainCheckout) {
    process.stderr.write(
      "[dev-loops] post-merge: main-checkout fast-forward skipped (best-effort): could not resolve main checkout from `git worktree list`.\n",
    );
  } else {
    try {
      execSync(buildMainCheckoutFastForwardCommand(mainCheckout), {
        cwd: mainCheckout,
        timeout: MAIN_CHECKOUT_FF_MERGE_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      });
      process.stderr.write(
        "[dev-loops] post-merge: main checkout fast-forwarded local main to origin/main.\n",
      );
    } catch (error) {
      const reason = error?.stderr?.toString?.()?.trim() || error?.message || String(error);
      process.stderr.write(
        `[dev-loops] post-merge: main-checkout fast-forward skipped (best-effort): ${reason}\n`,
      );
    }
  }

  // Post-merge worktree removal (#1627): the loop mandates removing the branch's
  // worktree after merge but never performed it. Runs from the main checkout (the
  // hook's cwd can be inside the worktree being removed) and stays non-fatal.
  const prNumber = extractPrNumberFromGhPrMergeAnywhere(command);
  if (mainCheckout && prNumber) {
    const cleanupCommand = buildWorktreeCleanupCommand(mainCheckout, prNumber);
    if (cleanupCommand) {
      try {
        execSync(cleanupCommand, {
          cwd: mainCheckout,
          timeout: WORKTREE_CLEANUP_TIMEOUT_MS,
          stdio: ["ignore", "pipe", "pipe"],
        });
        process.stderr.write(
          `[dev-loops] post-merge: worktree cleanup ran for PR #${prNumber}.\n`,
        );
      } catch (error) {
        const reason = error?.stderr?.toString?.()?.trim() || error?.message || String(error);
        process.stderr.write(
          `[dev-loops] post-merge: worktree cleanup skipped (best-effort): ${reason}\n`,
        );
      }
    }
  }
}
process.exit(0);
