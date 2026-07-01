/**
 * Shared worktree-relative repo-root / ledger-checkout resolver (issue #1052,
 * folds #1019 and #1050). ONE shared resolver: derive repo root from the
 * checkout under operation (git-toplevel, not ambient cwd) for config reads,
 * and enumerate ALL checkouts (main + every worktree) for ledger reads so a
 * ledger written in any worktree is visible regardless of which checkout runs
 * the check.
 *
 * #1050: the pre-PR-worktree flow means the session cwd is a DIFFERENT checkout
 * than the PR worktree. Ledgers get written cwd-relative in the PR worktree but
 * read cwd-relative from the session checkout, so they diverge and clean gates
 * false-block on "missing pre-merge gate evidence". resolveLedgerCheckouts
 * enumerates every checkout so a ledger written in one is found from any.
 *
 * #1019: .devloops is read at EXACTLY <repoRoot>/.devloops with no upward walk.
 * Reading it from process.cwd() (a subdir or sibling checkout) silently falls
 * back to defaults (maxCopilotRounds -> 5). resolveRepoRoot derives the root
 * from the checkout's git-toplevel so config resolves correctly.
 */
import { execFileSync } from "node:child_process";
import { parseAllWorktreePaths, parseMainWorktreePath } from "@dev-loops/core/loop/worktree-guard";

export function resolveRepoRoot(cwd, { gitCommand = "git" } = {}) {
  try {
    return execFileSync(gitCommand, ["rev-parse", "--show-toplevel"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim() || cwd;
  } catch {
    return cwd;
  }
}

export function resolveLedgerCheckouts(cwd, { gitCommand = "git" } = {}) {
  const roots = [];
  const add = (p) => { if (typeof p === "string" && p.length > 0 && !roots.includes(p)) roots.push(p); };
  add(resolveRepoRoot(cwd, { gitCommand }));
  try {
    const listing = execFileSync(gitCommand, ["worktree", "list"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    add(parseMainWorktreePath(listing));
    for (const p of parseAllWorktreePaths(listing)) add(p);
  } catch { /* git unavailable: cwd-toplevel is all we have */ }
  if (roots.length === 0) add(cwd);
  return roots;
}
