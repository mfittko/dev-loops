import fs from "node:fs";
import path from "node:path";

/**
 * A shell working directory can silently reset to the primary checkout — after a
 * subprocess run, or when a `cd` inside a compound command does not persist. An
 * agent that then runs a relative-path `git commit && git push` executes it in
 * the PRIMARY checkout on the DEFAULT branch, so the change lands straight on
 * the remote's default branch and skips the PR flow entirely. Prose in a
 * contract cannot stop that; the shell never read it.
 *
 * These hooks make the dangerous operation itself fail. Linked worktrees DO run
 * them — git resolves hooks from the common directory, which every worktree
 * shares — so what spares the loop's own work is the branch/ref check, not the
 * hook's absence. A sanctioned release or reconcile sets DEVLOOPS_ALLOW_MAIN=1
 * to proceed deliberately.
 */
export const GUARD_MARKER = "dev-loops:default-branch-guard";
export const GUARD_OVERRIDE_ENV = "DEVLOOPS_ALLOW_MAIN";
export const GUARDED_HOOKS = Object.freeze(["pre-commit", "pre-push"]);

const REFUSAL_BODY = (what, branchExpr) => `  echo "dev-loops: refusing to ${what} ($${branchExpr}) from this checkout." >&2
  echo "  The dev-loop works in a linked worktree; a cwd that silently reset to the" >&2
  echo "  primary checkout is the usual cause. Re-run from the worktree, addressing it" >&2
  echo "  explicitly (git -C <absolute-worktree-path> ...)." >&2
  echo "  For a sanctioned release or reconcile: ${GUARD_OVERRIDE_ENV}=1 <command>" >&2`;

/**
 * @param {"pre-commit"|"pre-push"} hookName
 * @param {string|null} defaultBranch resolved at INSTALL time. Baking it in
 *   beats re-deriving it in shell: `origin/HEAD` is often absent, and a
 *   main-or-master guess picks a stale local `main` in a `master` repo, which
 *   would guard the wrong branch and leave the real default open.
 */
export function renderGuardHook(hookName, defaultBranch = null) {
  const resolvedDefault = typeof defaultBranch === "string" && defaultBranch.trim().length > 0
    ? defaultBranch.trim()
    : "";
  const header = `#!/bin/sh
# ${GUARD_MARKER}
# Refuses a ${hookName} that would land on the default branch. Installed in the
# common hook directory, so linked worktrees run it too — their branch is not
# the default, which is what lets their work through.
if [ -n "\${${GUARD_OVERRIDE_ENV}}" ]; then
  exit 0
fi
default="${resolvedDefault}"
if [ -z "$default" ]; then
  # Not resolvable at install time; fail OPEN rather than guess a branch and
  # protect the wrong one. The install reports this so it is not silent.
  exit 0
fi
`;

  if (hookName === "pre-commit") {
    return `${header}
branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || exit 0
if [ "$branch" = "$default" ]; then
${REFUSAL_BODY("commit on the default branch", "branch")}
  exit 1
fi
exit 0
`;
  }

  // pre-push receives "<local ref> <local sha> <remote ref> <remote sha>" per
  // line on stdin. Checking the CURRENT branch instead would miss every
  // explicit refspec — `git push origin HEAD:main` from a feature branch is the
  // exact shape that moved a remote default in testing.
  return `${header}
blocked=0
while read -r local_ref local_sha remote_ref remote_sha; do
  [ -n "$remote_ref" ] || continue
  case "$remote_ref" in
    "refs/heads/$default")
      blocked=1
      ;;
  esac
done
if [ "$blocked" = "1" ]; then
${REFUSAL_BODY("push to the default branch", "default")}
  exit 1
fi
exit 0
`;
}

function readHookState(hookPath) {
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
 * @param {{ gitDir: string, defaultBranch?: string|null, hooksPathOverride?: string|null }} target
 *   `hooksPathOverride` is the repo's `core.hooksPath` when set. Installing into
 *   `$GIT_DIR/hooks` while git reads elsewhere would report success for a guard
 *   that can never fire, so that case refuses instead.
 */
export function installDefaultBranchGuard({ gitDir, defaultBranch = null, hooksPathOverride = null }) {
  if (typeof hooksPathOverride === "string" && hooksPathOverride.trim().length > 0) {
    return {
      ok: false,
      installed: [],
      refreshed: [],
      skipped: GUARDED_HOOKS.map((hook) => ({ hook, reason: `core.hooksPath is set to "${hooksPathOverride.trim()}", so hooks in $GIT_DIR/hooks would never run` })),
      reason: `core.hooksPath is set to "${hooksPathOverride.trim()}" — install the guard there, or unset it, or use ${GUARD_OVERRIDE_ENV} discipline instead`,
    };
  }

  const resolvedDefault = typeof defaultBranch === "string" && defaultBranch.trim().length > 0
    ? defaultBranch.trim()
    : null;
  const hooksDir = path.join(gitDir, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });

  const installed = [];
  const refreshed = [];
  const skipped = [];

  for (const hook of GUARDED_HOOKS) {
    const hookPath = path.join(hooksDir, hook);
    const { ours, absent } = readHookState(hookPath);
    if (!ours) {
      skipped.push({ hook, reason: "a pre-existing hook is present and was left untouched" });
      continue;
    }
    fs.writeFileSync(hookPath, renderGuardHook(hook, resolvedDefault));
    // chmod separately: writeFileSync's mode argument is ignored when the file
    // already exists, and git silently ignores a non-executable hook.
    fs.chmodSync(hookPath, 0o755);
    (absent ? installed : refreshed).push(hook);
  }

  return {
    ok: true,
    installed,
    refreshed,
    skipped,
    defaultBranch: resolvedDefault,
    ...(resolvedDefault ? {} : { reason: "default branch could not be resolved at install time; the hooks are inert rather than guessing which branch to protect" }),
  };
}
