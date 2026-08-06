// GENERATED from packages/core/src/loop/main-checkout-ff.mjs by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate.
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
 * push). `mainCheckout` is POSIX single-quoted so consumer checkout paths containing
 * spaces or shell metacharacters cannot break or inject into the shell string.
 *
 * No imports so this file vendors into the `.claude/hooks/` bundle unchanged
 * (vendored modules may only import `node:` builtins or relative paths).
 */

/**
 * Timeout (ms) for the `git worktree list` resolution step (the fetch-half budget;
 * a separate fetch timeout isn't applied — the fetch runs inline within the merge
 * command under `MAIN_CHECKOUT_FF_MERGE_TIMEOUT_MS`).
 */
export const MAIN_CHECKOUT_FF_FETCH_TIMEOUT_MS = 60_000;

/** Timeout (ms) for the `git merge --ff-only origin/main` half. */
export const MAIN_CHECKOUT_FF_MERGE_TIMEOUT_MS = 60_000;

/**
 * POSIX single-quote a path so spaces/shell metacharacters in a consumer's checkout
 * path cannot break or inject into the shell string.
 */
function shellQuotePath(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Build the best-effort main-checkout fast-forward command string.
 *
 * @param {string} mainCheckout - Absolute path to the main (primary) git checkout.
 * @returns {string} `git -C '<mainCheckout>' fetch origin main && git -C '<mainCheckout>' merge --ff-only origin/main` (path POSIX single-quoted)
 */
export function buildMainCheckoutFastForwardCommand(mainCheckout) {
  const quoted = shellQuotePath(mainCheckout);
  return `git -C ${quoted} fetch origin main && git -C ${quoted} merge --ff-only origin/main`;
}
