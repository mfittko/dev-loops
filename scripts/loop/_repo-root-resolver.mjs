/**
 * Shared worktree-relative repo-root / ledger-checkout resolver. ONE shared
 * resolver: derive repo root from the checkout under operation (git-toplevel,
 * not ambient cwd) for config reads, and enumerate ALL checkouts (main +
 * every worktree) for ledger reads so a ledger written in any worktree is
 * visible regardless of which checkout runs the check.
 *
 * The pre-PR-worktree flow means the session cwd can be a DIFFERENT checkout
 * than the PR worktree. Ledgers get written cwd-relative in the PR worktree but
 * read cwd-relative from the session checkout, so they diverge and clean gates
 * false-block on "missing pre-merge gate evidence". resolveLedgerCheckouts
 * enumerates every checkout so a ledger written in one is found from any.
 *
 * .devloops is read at EXACTLY <repoRoot>/.devloops with no upward walk.
 * Reading it from process.cwd() (a subdir or sibling checkout) silently falls
 * back to defaults (maxCopilotRounds -> 5). resolveRepoRoot derives the root
 * from the checkout's git-toplevel so config resolves correctly.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseAllWorktreePaths, parseMainWorktreePath, realpathNearestExisting, resolveContainingWorktreeRoot } from "@dev-loops/core/loop/worktree-guard";

// Scrub GIT_DIR/GIT_WORK_TREE for every git call in this module: an inherited
// pointer to a DIFFERENT repo overrides `cwd` outright, so `git rev-parse` /
// `git worktree list` would resolve that repo instead of the checkout under
// operation — mis-anchoring the ledger for the writer AND letting the merge-time
// reader (resolveLedgerCheckouts) enumerate the wrong repo and report missing
// provenance. Mirrors write-gate-context.mjs's gitEnvWithoutDirOverrides.
export function gitEnvNoDirOverrides() {
  return { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };
}

export function resolveRepoRoot(cwd, { gitCommand = "git" } = {}) {
  // A checkout root is already authoritative and needs no `git rev-parse`.
  // `.devloops` also identifies the synthetic repo roots used by hermetic
  // callers/tests, where spawning Git can only fail and adds avoidable fan-out.
  if (existsSync(path.join(cwd, ".git")) || existsSync(path.join(cwd, ".devloops"))) {
    return cwd;
  }
  try {
    return execFileSync(gitCommand, ["rev-parse", "--show-toplevel"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: gitEnvNoDirOverrides(),
    }).trim() || cwd;
  } catch {
    // git failed or cwd is not inside a git repo (or git is unavailable) -> fall back to cwd.
    return cwd;
  }
}

/**
 * Resolve the PRIMARY (main) git worktree root for `cwd`, independent of which
 * linked worktree `cwd` sits in. `git worktree list`'s first entry is always
 * the main checkout, so this returns the SAME path whether called from the main
 * checkout, a linked worktree, or a reviewer subagent whose cwd is a different
 * checkout of the same repo.
 *
 * This is the stable per-repo anchor for the gate findings-log LEDGER — the
 * `<tmpRoot>/gate-findings/...` provenance ledger the orchestrator's merge reads
 * from the MAIN checkout. A coordinator runs the gate inside an ephemeral linked
 * worktree; anchoring the ledger at the main worktree lands it in ONE location
 * the merge reaches and it survives linked-worktree pruning. It does NOT
 * govern the worktree-local gate-context/gate-reviews bundle (reviewers are
 * directed into the worktree; see write-gate-context.mjs's findings write-path
 * invariant) — only the ledger's own read/write callers use this anchor.
 *
 * Falls back to `resolveRepoRoot(cwd)` when git is unavailable or `cwd` is a
 * synthetic (`.devloops`, no `.git`) repo root used by hermetic callers/tests.
 */
const mainWorktreeCache = new Map();
export function resolveMainWorktreeRoot(cwd, { gitCommand = "git" } = {}) {
  const repoRoot = resolveRepoRoot(cwd, { gitCommand });
  // A synthetic `.devloops` root (no `.git`) can only fail `git worktree list`;
  // it IS its own main checkout, so short-circuit to avoid a pointless spawn.
  if (!existsSync(path.join(repoRoot, ".git"))) {
    return repoRoot;
  }
  if (mainWorktreeCache.has(repoRoot)) {
    return mainWorktreeCache.get(repoRoot);
  }
  let main = repoRoot;
  let resolved = false;
  try {
    const listing = execFileSync(gitCommand, ["worktree", "list"], {
      cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: gitEnvNoDirOverrides(),
    });
    const parsed = parseMainWorktreePath(listing);
    if (parsed) {
      main = parsed;
      resolved = true;
    }
  } catch { /* git failed/unavailable: the checkout root is the best anchor we have. */ }
  // Cache ONLY a real resolution: a transient `git worktree list` failure must
  // not pin repoRoot as "main" for the rest of a long-lived process, so a later
  // call retries once git recovers.
  if (resolved) {
    mainWorktreeCache.set(repoRoot, main);
  }
  return main;
}

/**
 * Absolute `tmp` root for the gate findings-log LEDGER, anchored at the main
 * worktree so the ledger lands in the ONE stable per-repo location. Callers use
 * this as the DEFAULT `tmpRoot` for ledger reads/writes ONLY (an explicit
 * `--tmp-root` still wins); the gate-context / gate-reviews / emit-plan /
 * carry-forward-plan artifacts intentionally stay worktree-local and must NOT be
 * relocated through this resolver. Because
 * the returned path is absolute, a later `path.resolve(<anyCheckout>, built)`
 * is a no-op prefix — every checkout collapses to the same location.
 */
export function resolveGateArtifactTmpRoot(cwd, { gitCommand = "git" } = {}) {
  return path.join(resolveMainWorktreeRoot(cwd, { gitCommand }), "tmp");
}

/**
 * Entries of `git worktree list --porcelain` run in `cwd`, in listing order:
 * `{ path, head, branch }` (`branch` is the full `refs/heads/...` ref, absent
 * on a detached or bare entry). The first entry is the main checkout, or the
 * bare repo when the main is bare. Throws on a git failure.
 */
export function listWorktreeEntries(cwd, { gitCommand = "git" } = {}) {
  const listing = execFileSync(gitCommand, ["worktree", "list", "--porcelain"], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnvNoDirOverrides(),
  });
  return listing.split(/\n\s*\n/u).map((block) => {
    const lines = block.split("\n");
    const field = (key) => lines.find((l) => l.startsWith(`${key} `))?.slice(key.length + 1);
    return { path: field("worktree"), head: field("HEAD"), branch: field("branch") };
  }).filter((e) => e.path);
}

/**
 * Refuse a gate findings ledger tmp root inside a LINKED worktree of the repo
 * at `repoRoot`: a ledger written there is lost on prune and unreadable by the
 * merge. `absTmpRoot` must already be resolved against the base the caller
 * writes under. The main checkout and paths outside every checkout stay
 * allowed. A git failure (e.g. `repoRoot` is not a git repo) leaves nothing to
 * compare against and allows the write.
 */
export function assertTmpRootOutsideLinkedWorktree(absTmpRoot, repoRoot, { gitCommand = "git" } = {}) {
  let entries;
  try {
    entries = listWorktreeEntries(repoRoot, { gitCommand });
  } catch {
    return;
  }
  const linked = entries.slice(1).map((e) => e.path);
  const containing = resolveContainingWorktreeRoot(realpathNearestExisting(absTmpRoot), linked);
  if (containing !== null) {
    throw new Error(`--tmp-root ${absTmpRoot} resolves inside the linked worktree ${containing}; gate findings ledgers must stay out of linked worktrees. Omit --tmp-root to use the main-anchored default ${resolveGateArtifactTmpRoot(repoRoot, { gitCommand })}`);
  }
}

export function resolveLedgerCheckouts(cwd, { gitCommand = "git" } = {}) {
  const roots = [];
  const add = (p) => { if (typeof p === "string" && p.length > 0 && !roots.includes(p)) roots.push(p); };
  add(resolveRepoRoot(cwd, { gitCommand }));
  if (!existsSync(path.join(cwd, ".git")) && existsSync(path.join(cwd, ".devloops"))) {
    return roots;
  }
  try {
    const listing = execFileSync(gitCommand, ["worktree", "list"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: gitEnvNoDirOverrides(),
    });
    add(parseMainWorktreePath(listing));
    for (const p of parseAllWorktreePaths(listing)) add(p);
  } catch { /* git failed, not inside a git repo, or git unavailable: cwd-toplevel is all we have */ }
  if (roots.length === 0) add(cwd);
  return roots;
}
