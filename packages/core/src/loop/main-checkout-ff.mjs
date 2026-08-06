/**
 * Main-checkout fast-forward command shape (#1596).
 *
 * The dev-loop merges remotely (`gh pr merge` → origin/main) but neither the merge
 * procedure nor the post-merge hooks fast-forwarded the main checkout's local
 * `main`. Read-only gate scripts (`probe-ci-status.mjs`, `detect-copilot-loop-state.mjs`,
 * …) run from the main checkout, so a stale local `main` made them execute pre-merge
 * code — re-introducing the CI-wait stall every PR (e.g. #1531's fix was invisible
 * until the main checkout caught up).
 *
 * This module owns the shared, dependency-free command string both harness hooks
 * (Pi `post-merge-update`, Claude `post-tool-use-merge`) run after a successful
 * merge. It is best-effort and NON-BLOCKING: `--ff-only` refuses a diverged `main`
 * without rewriting history, so a diverged checkout fails the merge step cleanly and
 * the caller treats that as warn-and-continue (never a hard failure, never a force
 * push). `mainCheckout` is substituted verbatim — repo paths have no spaces, matching
 * codebase style (no shell quoting).
 *
 * No imports so this file vendors into the `.claude/hooks/` bundle unchanged
 * (vendored modules may only import `node:` builtins or relative paths).
 */

/** Timeout (ms) for the `git fetch origin main` half of the fast-forward. */
export const MAIN_CHECKOUT_FF_FETCH_TIMEOUT_MS = 60_000;

/** Timeout (ms) for the `git merge --ff-only origin/main` half. */
export const MAIN_CHECKOUT_FF_MERGE_TIMEOUT_MS = 60_000;

/**
 * Build the best-effort main-checkout fast-forward command string.
 *
 * @param {string} mainCheckout - Absolute path to the main (primary) git checkout.
 * @returns {string} `git -C <mainCheckout> fetch origin main && git -C <mainCheckout> merge --ff-only origin/main`
 */
export function buildMainCheckoutFastForwardCommand(mainCheckout) {
  return `git -C ${mainCheckout} fetch origin main && git -C ${mainCheckout} merge --ff-only origin/main`;
}
