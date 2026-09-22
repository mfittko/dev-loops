// GENERATED from packages/core/src/loop/main-checkout-ff.mjs by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate.
/**
 * Main-checkout fast-forward flow.
 *
 * The dev-loop merges remotely (`gh pr merge` → origin/main) but neither the merge
 * procedure nor the post-merge hooks fast-forwarded the main checkout's local
 * `main`. Read-only gate scripts (`probe-ci-status.mjs`, `detect-copilot-loop-state.mjs`,
 * …) run from the main checkout, so a stale local `main` made them execute pre-merge
 * code — re-introducing the CI-wait stall every PR (e.g. #1531's fix was invisible
 * until the main checkout caught up).
 *
 * This module owns the shared, dependency-free step-wise flow both harness hooks
 * (Pi `post-merge-update`, Claude `post-tool-use-merge`) run after a successful
 * merge. It is best-effort and NON-BLOCKING: `--ff-only` refuses a diverged `main`
 * without rewriting history, so a diverged checkout fails the merge step cleanly and
 * the caller treats that as warn-and-continue (never a hard failure, never a force
 * push). `mainCheckout` is POSIX single-quoted so consumer checkout paths containing
 * spaces or shell metacharacters cannot break or inject into the shell string.
 *
 * `syncMainCheckout` inspects the current ref BEFORE submitting any merge command, so
 * a non-`main` checkout (detached HEAD, or another branch checked out) is classified
 * and reported as an action-required diagnostic instead of fast-forwarding the wrong
 * branch. No `git switch`/`checkout`/`reset` command is ever submitted for a non-main
 * checkout — only read-only inspection commands run.
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

/** Stable diagnostic kind for a main checkout proven not to be on `main`. */
export const MAIN_CHECKOUT_NOT_ON_MAIN_KIND = "main_checkout_not_on_main";

/**
 * POSIX single-quote a path so spaces/shell metacharacters in a consumer's checkout
 * path cannot break or inject into the shell string.
 */
function shellQuotePath(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Classify a main checkout's current full symbolic ref (`git rev-parse
 * --symbolic-full-name HEAD` output) into one of the four states `syncMainCheckout`
 * acts on. `--symbolic-full-name` (unlike `--abbrev-ref`) is never subject to
 * `core.warnAmbiguousRefs` renaming a branch to `heads/<name>` when a tag or other ref
 * shares its short name.
 *
 * @param {unknown} symbolicFullName - Raw (already-trimmed or not) `--symbolic-full-name
 *   HEAD` output.
 * @returns {"main" | "other_branch" | "detached" | "unreadable"}
 */
export function classifyMainCheckoutRef(symbolicFullName) {
  if (typeof symbolicFullName !== "string") {
    return "unreadable";
  }
  const trimmed = symbolicFullName.trim();
  if (!trimmed) {
    return "unreadable";
  }
  if (trimmed === "HEAD") {
    return "detached";
  }
  if (trimmed === "refs/heads/main") {
    return "main";
  }
  if (trimmed.startsWith("refs/heads/")) {
    return "other_branch";
  }
  return "unreadable";
}

/**
 * Build the `main_checkout_not_on_main` diagnostic, or `null` when any required field
 * is missing or invalid. The one shared rendered `message` names the kind, the
 * absolute checkout path, the current ref, the behind count, that no fast-forward
 * happened, that the action is non-fatal, and the manual recovery — never a
 * reset/force suggestion.
 *
 * @param {{ mainCheckout: unknown, ref: unknown, behindCount: unknown }} fields
 * @returns {{ kind: string, severity: "error", mainCheckout: string, ref: string, behindCount: number, message: string } | null}
 */
export function buildMainCheckoutNotOnMainDiagnostic({ mainCheckout, ref, behindCount } = {}) {
  if (typeof mainCheckout !== "string" || !path.isAbsolute(mainCheckout)) {
    return null;
  }
  if (typeof ref !== "string" || !ref.trim()) {
    return null;
  }
  if (!Number.isInteger(behindCount) || behindCount < 0) {
    return null;
  }
  const message =
    `[dev-loops] post-merge: ${MAIN_CHECKOUT_NOT_ON_MAIN_KIND} — the main checkout at '${mainCheckout}' ` +
    `is on ${ref}, ${behindCount} commit(s) behind origin/main after fetch. No fast-forward was performed; ` +
    `this is non-fatal. Reconcile manually: preserve any local-only commits, then check out main and ` +
    `fast-forward it to origin/main.`;
  return { kind: MAIN_CHECKOUT_NOT_ON_MAIN_KIND, severity: "error", mainCheckout, ref, behindCount, message };
}

/**
 * Run one shell-command step through the harness-supplied `run` adapter, normalizing
 * a thrown/rejected `run` into the same `{ ok: false, reason }` shape as an adapter
 * that resolves a failure — callers never need a second failure path.
 *
 * @param {(command: string) => Promise<{ ok: boolean, stdout?: string, reason?: string }>} run
 * @param {string} command
 * @returns {Promise<{ ok: true, stdout: string } | { ok: false, reason: string }>}
 */
async function runStep(run, command) {
  try {
    const result = await run(command);
    if (result?.ok) {
      return { ok: true, stdout: typeof result.stdout === "string" ? result.stdout : "" };
    }
    return { ok: false, reason: result?.reason || "command failed" };
  } catch (error) {
    return { ok: false, reason: error?.message || String(error) };
  }
}

/**
 * Best-effort, step-wise main-checkout sync.
 *
 * After a successful `fetch origin main`, inspects the checkout's current ref BEFORE
 * submitting any merge command:
 *   - `main` → `git merge --ff-only origin/main`; ok → `fast_forwarded`; a diverged
 *     main fails the merge step cleanly → `skipped`.
 *   - detached HEAD or another named branch → never merged/switched/reset; instead
 *     the post-fetch `HEAD..origin/main` behind count is measured and reported as a
 *     `not_on_main` diagnostic (see `buildMainCheckoutNotOnMainDiagnostic`).
 * Any step that cannot prove its outcome (fetch failure, unreadable ref, a failed or
 * empty short-SHA resolution, a failed or non-numeric behind-count read) is reported
 * as `skipped` instead of a partial diagnostic.
 *
 * @param {string} mainCheckout - Absolute path to the main (primary) git checkout.
 * @param {(command: string) => Promise<{ ok: boolean, stdout?: string, reason?: string }>} run
 *   Harness adapter that executes one shell command and resolves its outcome (may also
 *   throw — treated as a failed step).
 * @returns {Promise<
 *   | { status: "fast_forwarded" }
 *   | { status: "skipped", reason: string }
 *   | { status: "not_on_main", diagnostic: ReturnType<typeof buildMainCheckoutNotOnMainDiagnostic> }
 * >}
 */
export async function syncMainCheckout(mainCheckout, run) {
  const quoted = shellQuotePath(mainCheckout);

  const fetchResult = await runStep(run, `git -C ${quoted} fetch origin main`);
  if (!fetchResult.ok) {
    return { status: "skipped", reason: fetchResult.reason };
  }

  const refResult = await runStep(run, `git -C ${quoted} rev-parse --symbolic-full-name HEAD`);
  if (!refResult.ok) {
    return { status: "skipped", reason: refResult.reason };
  }
  const symbolicRef = refResult.stdout.trim();
  const classification = classifyMainCheckoutRef(symbolicRef);
  if (classification === "unreadable") {
    return { status: "skipped", reason: `could not determine the current branch (got: ${JSON.stringify(symbolicRef)})` };
  }

  if (classification === "main") {
    const mergeResult = await runStep(run, `git -C ${quoted} merge --ff-only origin/main`);
    if (!mergeResult.ok) {
      return { status: "skipped", reason: mergeResult.reason };
    }
    return { status: "fast_forwarded" };
  }

  let ref;
  if (classification === "detached") {
    const shortShaResult = await runStep(run, `git -C ${quoted} rev-parse --short HEAD`);
    if (!shortShaResult.ok) {
      return { status: "skipped", reason: shortShaResult.reason };
    }
    const shortSha = shortShaResult.stdout.trim();
    if (!shortSha) {
      return { status: "skipped", reason: "could not resolve a short SHA for the detached HEAD" };
    }
    ref = `detached@${shortSha}`;
  } else {
    ref = symbolicRef.slice("refs/heads/".length);
  }

  const behindResult = await runStep(run, `git -C ${quoted} rev-list --count HEAD..origin/main`);
  if (!behindResult.ok) {
    return { status: "skipped", reason: behindResult.reason };
  }
  const behindStdout = behindResult.stdout.trim();
  if (!/^\d+$/.test(behindStdout)) {
    return { status: "skipped", reason: `could not read the behind count (got: ${JSON.stringify(behindStdout)})` };
  }
  const behindCount = Number.parseInt(behindStdout, 10);

  const diagnostic = buildMainCheckoutNotOnMainDiagnostic({ mainCheckout, ref, behindCount });
  if (!diagnostic) {
    return { status: "skipped", reason: "incomplete main_checkout_not_on_main diagnostic" };
  }
  return { status: "not_on_main", diagnostic };
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

/**
 * Overall timeout (ms) for the post-merge actions runner invocation. Generous:
 * the runner itself bounds each declared action by its own timeoutMs/verify
 * budget (each individually capped at the config-schema ceiling), and this is
 * only the outer harness-hook guard against a runner that never returns.
 */
export const POST_MERGE_ACTIONS_TIMEOUT_MS = 900_000;

/**
 * Build the best-effort `postMerge.actions` runner command (#1457): the shared,
 * dependency-free command string both harness hooks (Pi `post-merge-update`,
 * Claude `post-tool-use-merge`) run after a successful merge, for the repo that
 * merged. Existence-guarded (a checkout without the runner script is a silent
 * no-op) and non-fatal (`|| true` — a runner failure must never break a
 * merge-completion flow; the runner itself reports per-action failures in its
 * own JSON result). `mainCheckout` and the script path are POSIX
 * single-quoted; `prNumber` (when a valid positive integer) is passed as a
 * double-quoted `--pr` argument — never interpolated into `run`/`verify`
 * command strings, which the runner executes verbatim from the repo's own
 * `.devloops`.
 *
 * @param {string} mainCheckout - Absolute path to the main (primary) git checkout.
 * @param {string | number | undefined} [prNumber] - Merged PR number, when known.
 * @returns {string} the runner command (always non-empty; a missing PR number
 *   just omits `--pr`, since `onlyIfChanged` scoping bypasses cleanly without one).
 */
export function buildPostMergeActionsCommand(mainCheckout, prNumber) {
  const quotedMain = shellQuotePath(mainCheckout);
  const script = shellQuotePath(path.join(mainCheckout, "scripts", "loop", "run-post-merge-actions.mjs"));
  const pr = String(prNumber ?? "").trim();
  const prArg = /^[0-9]+$/u.test(pr) ? ` --pr "${pr}"` : "";
  return `if [ -f ${script} ]; then node ${script} --repo-root ${quotedMain}${prArg}; fi || true`;
}
