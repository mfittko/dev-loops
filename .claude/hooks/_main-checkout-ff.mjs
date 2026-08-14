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
 * The `merge --ff-only` is guarded to only run when the main checkout is currently on
 * `main`, so a non-`main` checkout (detached HEAD, or another branch checked out)
 * warns-and-continues instead of fast-forwarding the wrong branch. No `git switch` is
 * performed (a state change) — only the guard test runs.
 *
 * No imports so this file vendors into the `.claude/hooks/` bundle unchanged
 * (vendored modules may only import `node:` builtins or relative paths).
 */
import path from "node:path";

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
 * @returns {string} `git -C '<main>' fetch origin main && [ "$(git -C '<main>' rev-parse --abbrev-ref HEAD)" = main ] && git -C '<main>' merge --ff-only origin/main` (path POSIX single-quoted; merge only runs when the main checkout is on `main`)
 */
export function buildMainCheckoutFastForwardCommand(mainCheckout) {
  const quoted = shellQuotePath(mainCheckout);
  // ponytail: guard with a `[ ... = main ]` test instead of switching branches — a
  // non-main checkout fails the && chain (warn-and-continue) rather than ff-ing the
  // wrong branch. No state change, no git switch.
  return `git -C ${quoted} fetch origin main && [ "$(git -C ${quoted} rev-parse --abbrev-ref HEAD)" = main ] && git -C ${quoted} merge --ff-only origin/main`;
}

/**
 * Worktree-cleanup timeout (ms) for the post-merge `git worktree remove` half.
 */
export const WORKTREE_CLEANUP_TIMEOUT_MS = 60_000;

/**
 * Build the best-effort post-merge worktree-removal command string (#1627).
 *
 * The dev-loop mandates removing the branch's worktree after merge, but neither
 * the merge procedure nor the post-merge hooks performed it. This builds the
 * shell command that runs the shared `cleanup-worktree.mjs` script FROM the main
 * checkout (the hook's cwd can be inside the worktree being removed, which makes
 * `git worktree remove` fail), and stays non-fatal: the script itself is fail-soft
 * (refuses any path outside tmp/worktrees/dev-loops/, exits 0 on git errors), and
 * the surrounding guard makes a consumer checkout without the script a silent no-op.
 * `prNumber` is shell-escaped as a double-quoted argument; `mainCheckout` and the
 * script path are POSIX single-quoted. Returns an empty string when no PR number
 * (or no meaningful target) is available, so callers can skip cleanly.
 *
 * @param {string} mainCheckout - Absolute path to the main (primary) git checkout.
 * @param {string | number | undefined} prNumber - Merged PR number (drives `--pr`).
 * @returns {string} the cleanup command, or "" when `prNumber` is absent.
 */
export function buildWorktreeCleanupCommand(mainCheckout, prNumber) {
  const pr = String(prNumber ?? "").trim();
  // Validate the PR number is a positive integer BEFORE embedding it into the
  // shell string; a caller passing a non-numeric string (could carry command
  // substitution) is refused by returning "" — defense-in-depth in a public helper.
  if (!/^[0-9]+$/u.test(pr)) {
    return "";
  }
  const quotedMain = shellQuotePath(mainCheckout);
  const script = shellQuotePath(path.join(mainCheckout, "scripts", "loop", "cleanup-worktree.mjs"));
  // Guard the script's existence (consumer no-op) and keep the whole thing
  // non-fatal with `|| true` — removal must never break a merge-completion flow.
  return `if [ -f ${script} ]; then node ${script} --repo-root ${quotedMain} --pr "${pr}"; fi || true`;
}
