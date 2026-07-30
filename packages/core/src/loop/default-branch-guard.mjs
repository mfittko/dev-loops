import fs from "node:fs";
import path from "node:path";

/**
 * A shell working directory can silently reset to the primary checkout — after a
 * subprocess run, or when a `cd` inside a compound command does not persist. An
 * agent that then runs a relative-path `git commit && git push` executes it in
 * the PRIMARY checkout on the DEFAULT branch, so the change lands straight on
 * the remote's main and skips the PR flow entirely. Prose in a contract cannot
 * stop that; the shell never read it.
 *
 * These hooks make the dangerous operation itself fail. They live only in the
 * primary checkout's hook directory, so linked worktrees (where the loop is
 * supposed to work) are untouched, and a sanctioned release or reconcile sets
 * DEVLOOPS_ALLOW_MAIN=1 to proceed deliberately.
 */
export const GUARD_MARKER = "dev-loops:default-branch-guard";
export const GUARD_OVERRIDE_ENV = "DEVLOOPS_ALLOW_MAIN";
export const GUARDED_HOOKS = Object.freeze(["pre-commit", "pre-push"]);

export function renderGuardHook(hookName) {
  return `#!/bin/sh
# ${GUARD_MARKER}
# Refuses a ${hookName} on the default branch in the PRIMARY checkout, where a
# silent cwd reset would otherwise land the change directly on the remote's
# default branch and bypass the PR flow. Linked worktrees never carry this hook.
if [ -n "\${${GUARD_OVERRIDE_ENV}}" ]; then
  exit 0
fi
branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || exit 0
default=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
if [ -z "$default" ]; then
  for candidate in main master; do
    if git show-ref --verify --quiet "refs/heads/$candidate"; then
      default="$candidate"
      break
    fi
  done
fi
[ -n "$default" ] || exit 0
if [ "$branch" = "$default" ]; then
  echo "dev-loops: refusing ${hookName} on the default branch ($branch) in the primary checkout." >&2
  echo "  The dev-loop works in a linked worktree; a cwd that silently reset to the" >&2
  echo "  primary checkout is the usual cause. Re-run from the worktree, addressing it" >&2
  echo "  explicitly (git -C <absolute-worktree-path> ...)." >&2
  echo "  For a sanctioned release or reconcile on the default branch: ${GUARD_OVERRIDE_ENV}=1 <command>" >&2
  exit 1
fi
exit 0
`;
}

function isOursOrAbsent(hookPath) {
  if (!fs.existsSync(hookPath)) return { ours: true, absent: true };
  const contents = fs.readFileSync(hookPath, "utf8");
  return { ours: contents.includes(GUARD_MARKER), absent: false };
}

/**
 * Install the guard hooks into a repository's hook directory.
 *
 * Idempotent: re-installing rewrites only hooks this guard authored. A hook the
 * user (or another tool) wrote is NEVER clobbered — that file is left exactly as
 * found and reported as `skipped`, because silently replacing someone's hook is
 * a worse failure than not installing ours.
 *
 * @param {{ gitDir: string }} target
 * @returns {{ ok: true, installed: string[], refreshed: string[], skipped: Array<{hook: string, reason: string}> }}
 */
export function installDefaultBranchGuard({ gitDir }) {
  const hooksDir = path.join(gitDir, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });

  const installed = [];
  const refreshed = [];
  const skipped = [];

  for (const hook of GUARDED_HOOKS) {
    const hookPath = path.join(hooksDir, hook);
    const { ours, absent } = isOursOrAbsent(hookPath);
    if (!ours) {
      skipped.push({ hook, reason: "a pre-existing hook is present and was left untouched" });
      continue;
    }
    fs.writeFileSync(hookPath, renderGuardHook(hook), { mode: 0o755 });
    // chmod separately: writeFileSync's mode is ignored when the file exists.
    fs.chmodSync(hookPath, 0o755);
    (absent ? installed : refreshed).push(hook);
  }

  return { ok: true, installed, refreshed, skipped };
}
