/**
 * Shared worktree and subagent guard primitives.
 *
 * Extracted from `scripts/loop/pre-commit-branch-guard.mjs` so that both the
 * pre-commit guard and the new pre-flight gate share one implementation.
 *
 * This module is intentionally pure and side-effect free.
 */

import { realpathSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Worktree path helpers
// ---------------------------------------------------------------------------

/**
 * Check whether `cwd` is under a tmp/worktrees path segment.
 *
 * @param {string} cwd - Absolute or relative path to the current working directory.
 * @returns {boolean}
 */
export function isUnderWorktreePath(cwd) {
  const normalized = cwd.replace(/\\/g, "/");
  return /(?:^|\/)tmp\/worktrees(?:\/|$)/.test(normalized);
}

/**
 * Parse the main (primary) git worktree path from `git worktree list` output.
 *
 * The first line of `git worktree list` is the primary worktree.
 * Format: `<path>  <sha> [<branch>]`
 *
 * @param {string} worktreeListOutput - Raw stdout from `git worktree list`.
 * @returns {string | null} The main worktree path, or null if it cannot be parsed.
 */
export function parseMainWorktreePath(worktreeListOutput) {
  const firstLine = worktreeListOutput.split("\n")[0].trim();
  if (!firstLine) return null;
  // Find the first hex SHA (7+ chars) preceded by whitespace; take everything before it as the path.
  const shaIdx = firstLine.search(/\s[0-9a-f]{7,64}\b/iu);
  if (shaIdx === -1) return null;
  return firstLine.slice(0, shaIdx).trim();
}

/**
 * Check whether `cwd` is the main git checkout (or a subdirectory of it).
 *
 * @param {string} cwd - Absolute or relative path to the current working directory.
 * @param {string | null} mainWorktreePath - The main worktree path from `parseMainWorktreePath`.
 * @returns {boolean}
 */
export function isMainCheckout(cwd, mainWorktreePath) {
  if (!mainWorktreePath) return false;
  let resolvedCwd;
  try { resolvedCwd = realpathSync(cwd); } catch { resolvedCwd = cwd; }
  let resolvedMain;
  try { resolvedMain = realpathSync(mainWorktreePath); } catch { resolvedMain = mainWorktreePath; }
  const normalizedCwd = resolvedCwd.replace(/\\/g, "/").replace(/\/+$/u, "");
  const normalizedMain = resolvedMain.replace(/\\/g, "/").replace(/\/+$/u, "");
  return normalizedCwd === normalizedMain || normalizedCwd.startsWith(normalizedMain + "/");
}

/**
 * Parse all worktree paths from `git worktree list` output.
 *
 * Each line in the output has the format `<path>  <sha> [<branch>]`.
 * Returns absolute paths (one per worktree), preserving list order.
 *
 * @param {string} worktreeListOutput - Raw stdout from `git worktree list`.
 * @returns {string[]}
 */
export function parseAllWorktreePaths(worktreeListOutput) {
  const paths = [];
  for (const line of worktreeListOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const shaIdx = trimmed.search(/\s[0-9a-f]{7,64}\b/iu);
    if (shaIdx === -1) continue;
    paths.push(trimmed.slice(0, shaIdx).trim());
  }
  return paths;
}

/**
 * Check whether `cwd` is listed as a git worktree by `git worktree list`.
 *
 * This is stricter than `isUnderWorktreePath()` — a manually-created
 * `tmp/worktrees/<slug>/` directory inside the main checkout passes
 * `isUnderWorktreePath()` but fails `isListedWorktree()` because it is
 * not a real git worktree.
 *
 * Resolves symlinks via realpathSync so that /var vs /private/var
 * differences on macOS do not cause false negatives.
 *
 * @param {string} cwd - Absolute or relative path to the current working directory.
 * @param {string[]} worktreePaths - Array of paths from `parseAllWorktreePaths`.
 * @returns {boolean}
 */
export function isListedWorktree(cwd, worktreePaths) {
  let resolvedCwd;
  try { resolvedCwd = realpathSync(cwd); } catch { resolvedCwd = cwd; }
  const normalized = resolvedCwd.replace(/\\/g, "/").replace(/\/+$/u, "");
  return worktreePaths.some((p) => {
    let resolvedP;
    try { resolvedP = realpathSync(p); } catch { resolvedP = p; }
    const normalizedP = resolvedP.replace(/\\/g, "/").replace(/\/+$/u, "");
    // Only match worktree paths that are under tmp/worktrees/ (exclude main checkout).
    if (!isUnderWorktreePath(normalizedP)) return false;
    // Accept exact match or cwd is a subdirectory of a listed worktree root.
    return normalized === normalizedP || normalized.startsWith(normalizedP + "/");
  });
}

/**
 * Resolve the root of the listed git worktree that contains `cwd`.
 *
 * Returns the worktree ROOT (realpath-resolved, exact-or-subdirectory match)
 * instead of a boolean, so callers can address files relative to the worktree's
 * own subtree (`packages/`, `node_modules/`) rather than the possibly-nested
 * `cwd`. Matches ANY listed worktree — not just `tmp/worktrees/`-scoped ones —
 * so the core-isolation invariant is evaluable for a sibling/linked checkout
 * that lives outside `tmp/worktrees/`; the caller decides admit/reject.
 * When `cwd` sits under nested worktrees (a `tmp/worktrees/` child inside its
 * parent checkout), the LONGEST matching root wins, so the innermost worktree's
 * own subtree is addressed regardless of `git worktree list` order.
 *
 * @param {string} cwd - Absolute or relative path inside the worktree.
 * @param {string[]} worktreePaths - Array of paths from `parseAllWorktreePaths`.
 * @returns {string | null} The worktree root path, or null when `cwd` is not inside a listed worktree.
 */
export function resolveContainingWorktreeRoot(cwd, worktreePaths) {
  let resolvedCwd;
  try { resolvedCwd = realpathSync(cwd); } catch { resolvedCwd = cwd; }
  const normalizedCwd = resolvedCwd.replace(/\\/g, "/").replace(/\/+$/u, "");
  let best = null;
  for (const p of worktreePaths) {
    let resolvedP;
    try { resolvedP = realpathSync(p); } catch { resolvedP = p; }
    const normalizedP = resolvedP.replace(/\\/g, "/").replace(/\/+$/u, "");
    if (normalizedCwd === normalizedP || normalizedCwd.startsWith(normalizedP + "/")) {
      if (best === null || normalizedP.length > best.length) best = normalizedP;
    }
  }
  return best;
}

/**
 * Check whether a worktree's `node_modules/@dev-loops/core` resolves into the
 * worktree's OWN `packages/core`, not the main checkout's (#1627).
 *
 * A link escaping to the main checkout silently tests main's core instead of the
 * branch's (WORKTREE-DEPS-ISOLATED / WORKTREE-CREATE-PROVISION): the forbidden
 * state is a worktree whose node_modules resolves dependencies from the main
 * checkout.
 *
 * Tolerates consumer repos with no `packages/core` (no monorepo core to isolate,
 * so the requirement is vacuously satisfied), and worktrees whose
 * `node_modules/@dev-loops/core` link is absent (nothing resolves out of tree, so
 * there is no escape to refuse). Only a link that RESOLVES and points outside the
 * worktree's own `packages/core` is treated as the escaping (non-isolated) state.
 * The worktree root is resolved from `cwd` via the listed worktree paths so a
 * nested `cwd` still addresses the worktree's own subtree.
 *
 * @param {string} cwd - Absolute or relative path inside the worktree.
 * @param {string[]} worktreePaths - Array of paths from `parseAllWorktreePaths`.
 * @returns {boolean} true when isolated (or no core to isolate); false when the
 *   core link escapes the worktree's own `packages/core`.
 */
export function isWorktreeCoreIsolated(cwd, worktreePaths) {
  const root = resolveContainingWorktreeRoot(cwd, worktreePaths);
  if (root === null) {
    // Not resolving to a listed worktree — isolation is enforced elsewhere
    // (isListedWorktree / isUnderWorktreePath); vacuously satisfied here.
    return true;
  }
  const coreDir = path.join(root, "packages", "core");
  const linkPath = path.join(root, "node_modules", "@dev-loops", "core");
  const normalize = (p) => {
    try {
      return realpathSync(p).replace(/\\/g, "/").replace(/\/+$/u, "");
    } catch {
      return null;
    }
  };
  const coreReal = normalize(coreDir);
  if (coreReal === null) {
    // Consumer repo with no packages/core — no monorepo core to isolate.
    return true;
  }
  const linkReal = normalize(linkPath);
  if (linkReal === null) {
    // node_modules/@dev-loops/core absent — nothing resolves out of tree.
    return true;
  }
  return linkReal === coreReal;
}

/**
 * Shared admit/reject decision for local-implementation worktree isolation.
 *
 * The single source of truth both enforcement sites route through
 * (`pre-flight-gate.mjs` `checkWorktreeIsolation` and
 * `resolve-dev-loop-startup.mjs`'s `local_implementation` block), so they
 * cannot diverge. Each caller maps the returned `error`/`detail` to its own
 * guidance/reason wording; this function owns only the decision.
 *
 * `tmp/worktrees/` stays the default and recommended location, but it is not
 * the invariant. The real invariant is core isolation: a checkout's
 * `node_modules/@dev-loops/core` resolves to its OWN `packages/core`.
 * A checkout OUTSIDE `tmp/worktrees/` that is not the main checkout and
 * satisfies that invariant is admitted rather than rejected on path prefix
 * alone; one that does not satisfy it (its core link escapes its own
 * `packages/core`) fails closed.
 *
 * Decision order:
 *  - outside `tmp/worktrees/` + main checkout  -> reject `main_checkout_detected`
 *  - outside `tmp/worktrees/` + unresolvable worktree root -> reject `not_in_worktree` (fail closed, no vacuous admit)
 *  - outside `tmp/worktrees/` + core-isolated  -> ADMIT (verified-isolation)
 *  - outside `tmp/worktrees/` + not isolated   -> reject `not_in_worktree`
 *  - under `tmp/worktrees/` + not a real worktree -> reject `not_in_worktree`
 *  - under `tmp/worktrees/` + core link escapes -> reject `core_link_escapes`
 *  - otherwise -> ADMIT
 *
 * @param {object} params
 * @param {string} params.cwd - Current working directory (absolute or relative).
 * @param {string | null} params.mainWorktreePath - From `parseMainWorktreePath`.
 * @param {string[]} params.allWorktreePaths - From `parseAllWorktreePaths`.
 * @returns {{ ok: true } | { ok: false, error: string, detail: string }}
 */
export function classifyWorktreeIsolation({ cwd, mainWorktreePath, allWorktreePaths }) {
  if (!isUnderWorktreePath(cwd)) {
    if (mainWorktreePath !== null && isMainCheckout(cwd, mainWorktreePath)) {
      return { ok: false, error: "main_checkout_detected", detail: "main_checkout" };
    }
    // Outside tmp/worktrees and not the main checkout: assert the REAL
    // core-isolation invariant instead of rejecting on path prefix alone.
    // The invariant is only meaningful for a checkout that resolves to a real
    // listed git worktree root; when the root cannot be resolved (an unlisted
    // checkout, or an empty/unparseable `git worktree list` — which also nulls
    // mainWorktreePath and skips the main-checkout guard above) the core-isolation
    // check would vacuously return true, so fail closed rather than admit.
    if (resolveContainingWorktreeRoot(cwd, allWorktreePaths) === null) {
      return { ok: false, error: "not_in_worktree", detail: "outside_not_isolated" };
    }
    if (isWorktreeCoreIsolated(cwd, allWorktreePaths)) {
      return { ok: true };
    }
    return { ok: false, error: "not_in_worktree", detail: "outside_not_isolated" };
  }
  if (!isListedWorktree(cwd, allWorktreePaths)) {
    return { ok: false, error: "not_in_worktree", detail: "fake_worktree" };
  }
  if (!isWorktreeCoreIsolated(cwd, allWorktreePaths)) {
    return { ok: false, error: "core_link_escapes", detail: "core_escapes" };
  }
  return { ok: true };
}


/**
 * Realpath-normalize a path that MAY NOT EXIST yet.
 *
 * `realpathSync` throws ENOENT on a nonexistent leaf — which is exactly a `Write`
 * creating a NEW file. Resolving only the roots (worktree/main) while leaving the
 * target un-normalized makes an under-a-symlinked-ancestor comparison asymmetric,
 * so a wrong-checkout new-file write could be misclassified. This resolves the
 * realpath of the target's NEAREST EXISTING ancestor and rejoins the nonexistent
 * tail, so the returned path shares the same symlink-resolved prefix the roots do.
 *
 * @param {string} p - Absolute or relative path (possibly not yet existing).
 * @returns {string} A realpath-normalized absolute path (forward-slash, no trailing slash).
 */
export function realpathNearestExisting(p) {
  const abs = path.resolve(p);
  let dir = abs;
  const tail = [];
  // Walk up to the nearest existing ancestor.
  for (;;) {
    try {
      const real = realpathSync(dir);
      const joined = tail.length ? path.join(real, ...tail) : real;
      return joined.replace(/\\/g, "/").replace(/\/+$/u, "");
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) {
        // Reached the filesystem root without an existing ancestor — fall back
        // to the literal resolved path (nothing to realpath against).
        return abs.replace(/\\/g, "/").replace(/\/+$/u, "");
      }
      tail.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

/**
 * Map a `git check-ignore -q` outcome to whether a MAIN-checkout target must be
 * treated as a guarded (non-gitignored) file, failing SAFE on an unresolvable
 * outcome.
 *
 * `git check-ignore -q` exits 0 when the path IS gitignored and 1 when it is NOT.
 * Any other exit (git error, missing binary) is UNRESOLVABLE: the wrong-checkout
 * guard must not silently allow a write it cannot classify, so an unresolvable
 * outcome is treated as guarded (deny) rather than ignored (allow).
 *
 * @param {number|null|undefined} checkIgnoreStatus - The `git check-ignore -q` exit status (null when it could not run).
 * @returns {boolean} true when the target should be guarded (not-ignored, or unresolvable → fail-safe); false only when it is confirmed gitignored (exit 0).
 */
export function resolveTrackedFromCheckIgnore(checkIgnoreStatus) {
  if (checkIgnoreStatus === 0) return false; // confirmed gitignored — not guarded
  if (checkIgnoreStatus === 1) return true; // confirmed not-ignored — guarded
  return true; // unresolvable — fail safe (AC4)
}


// ---------------------------------------------------------------------------
// Subagent availability
// ---------------------------------------------------------------------------

/**
 * Neutral environment variable name checked by `detectSubagentAvailability`.
 *
 * Set `DEVLOOPS_SUBAGENT_AVAILABLE=1` when the runtime supports subagent dispatch.
 * This is consistent with the `DEVLOOPS_WORKTREE_BYPASS` pattern and other repo-local
 * runtime configuration gates already present in the repo.
 */
export const DEVLOOPS_SUBAGENT_AVAILABLE_VAR = "DEVLOOPS_SUBAGENT_AVAILABLE";

/** Availability env var names. */
export const SUBAGENT_AVAILABLE_VARS = Object.freeze([DEVLOOPS_SUBAGENT_AVAILABLE_VAR]);

/**
 * Detect whether subagent dispatch is available in the current runtime.
 *
 * This is an env-var-based heuristic, consistent with other bypass/availability
 * patterns in the repo. It is intentionally simple — the gate's subagent check
 * is advisory (fails-open) and never hard-blocks on subagent absence. The var that is
 * *set* (non-blank) is authoritative — so an explicit `DEVLOOPS_SUBAGENT_AVAILABLE=0` is
 * respected as a hard "not available".
 *
 * @param {{ env?: Record<string, string | undefined> }} [options]
 * @returns {boolean}
 */
export function detectSubagentAvailability({ env = process.env } = {}) {
  for (const name of SUBAGENT_AVAILABLE_VARS) {
    const raw = (env[name] ?? "").trim();
    if (raw.length > 0) {
      return raw === "1";
    }
  }
  return false;
}
