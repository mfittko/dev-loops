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
import {
  WORKTREE_CLEANUP_TIMEOUT_MS,
  MAIN_CHECKOUT_FF_FETCH_TIMEOUT_MS,
  MAIN_CHECKOUT_FF_MERGE_TIMEOUT_MS,
  buildWorktreeCleanupCommand,
  buildPostMergeActionsCommand,
  POST_MERGE_ACTIONS_TIMEOUT_MS,
  syncMainCheckout,
} from "./_main-checkout-ff.mjs";

import { readHookInput } from "./_hook-io.mjs";

/**
 * Build a `syncMainCheckout` run() adapter over a synchronous `execSync` call in
 * `mainCheckout`, normalizing a thrown failure into `{ ok: false, reason }`.
 */
function makeSyncExecRun(mainCheckout) {
  return async (command) => {
    try {
      const stdout = execSync(command, {
        cwd: mainCheckout,
        timeout: MAIN_CHECKOUT_FF_MERGE_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
      });
      return { ok: true, stdout };
    } catch (error) {
      const reason = error?.stderr?.toString?.()?.trim() || error?.message || String(error);
      return { ok: false, reason };
    }
  };
}

// Set to the action-required diagnostic message when the main checkout is proven
// detached or on another branch. Surfaced as a structured PostToolUse `systemMessage`
// on stdout AFTER all other hook work, never mixed with the generic stderr warning
// used for every other skip reason.
let notOnMainMessage = null;

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
    const syncResult = await syncMainCheckout(mainCheckout, makeSyncExecRun(mainCheckout));
    if (syncResult.status === "fast_forwarded") {
      process.stderr.write(
        "[dev-loops] post-merge: main checkout fast-forwarded local main to origin/main.\n",
      );
    } else if (syncResult.status === "not_on_main") {
      notOnMainMessage = syncResult.diagnostic.message;
    } else {
      process.stderr.write(
        `[dev-loops] post-merge: main-checkout fast-forward skipped (best-effort): ${syncResult.reason}\n`,
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

  // Post-merge configured actions (postMerge.actions, #1457): a repo declaring
  // this family in its .devloops runs its own local actions (sync checkout,
  // restart a local service, smoke check) after merge. Existence-guarded (a
  // checkout without the runner script is a silent no-op) and non-fatal — a
  // runner failure never blocks this hook, which always exits 0. The runner
  // itself stays silent (no stdout) when the repo declares no postMerge.actions,
  // so relaying its output here produces zero new log lines for that case too.
  if (mainCheckout) {
    let output = "";
    try {
      output = execSync(buildPostMergeActionsCommand(mainCheckout, prNumber), {
        cwd: mainCheckout,
        timeout: POST_MERGE_ACTIONS_TIMEOUT_MS,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (error) {
      output = (error?.stdout ?? "").toString();
    }
    const trimmed = output.trim();
    if (trimmed) {
      process.stderr.write(`[dev-loops] post-merge: post-merge actions: ${trimmed}\n`);
    }
  }
}

// A detached-or-other-branch main checkout is action-required: after ALL other
// best-effort hook work has run, surface it as a structured PostToolUse `systemMessage`
// on stdout. This is the ONLY thing this hook ever writes to stdout, and it never mixes
// with the generic stderr warning above. Still non-fatal: always exit 0.
if (notOnMainMessage) {
  process.stdout.write(JSON.stringify({ systemMessage: notOnMainMessage }) + "\n");
}
process.exit(0);
