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
 * Git's ref rules forbid spaces and control characters but permit `$`, backtick,
 * quotes, `;`, `&`, `|` and parentheses — every one of which sh expands inside
 * the double-quoted assignment below. A branch named `main$(id)` would execute
 * on every commit, and `main$HOME` would expand to something that never matches
 * the real branch, leaving the default silently unguarded. Only names matching
 * this are baked in; anything else is refused at the install boundary.
 */
const SHELL_SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/;

/**
 * @param {"pre-commit"|"pre-push"} hookName
 * @param {string|null} defaultBranch resolved at INSTALL time. Baking it in
 *   beats re-deriving it in shell: `origin/HEAD` is often absent, and a
 *   main-or-master guess picks a stale local `main` in a `master` repo, which
 *   would guard the wrong branch and leave the real default open.
 * @throws {Error} when defaultBranch is non-empty and not shell-safe — this
 *   function is the actual trust boundary (it is what interpolates the name
 *   into shell), not just its installDefaultBranchGuard caller, so it must
 *   refuse on its own rather than rely on every caller re-checking first.
 */
export function renderGuardHook(hookName, defaultBranch = null) {
  const resolvedDefault = typeof defaultBranch === "string" && defaultBranch.trim().length > 0
    ? defaultBranch.trim()
    : "";
  if (resolvedDefault && !SHELL_SAFE_BRANCH.test(resolvedDefault)) {
    throw new Error(
      `default branch ${JSON.stringify(resolvedDefault)} contains characters the generated hook's shell would expand; refusing to render a hook that could execute it`,
    );
  }
  const header = `#!/bin/sh
# ${GUARD_MARKER}
# Refuses a ${hookName} that would land on the default branch. Installed in the
# common hook directory, so linked worktrees run it too — their branch is not
# the default, which is what lets their work through.
if [ "\${${GUARD_OVERRIDE_ENV}}" = "1" ]; then
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
  const refuse = (reason, skipReason) => ({
    ok: false,
    installed: [],
    refreshed: [],
    skipped: GUARDED_HOOKS.map((hook) => ({ hook, reason: skipReason })),
    reason,
  });

  if (typeof hooksPathOverride === "string" && hooksPathOverride.trim().length > 0) {
    const configured = hooksPathOverride.trim();
    return refuse(
      `core.hooksPath is set to "${configured}" — install the guard there, or unset it, or use ${GUARD_OVERRIDE_ENV} discipline instead`,
      `core.hooksPath is set to "${configured}", so hooks in $GIT_DIR/hooks would never run`,
    );
  }

  // A relative or empty gitDir resolves against the caller's cwd, which writes a
  // stray hooks/ directory into the working tree and reports success for a guard
  // git will never read.
  if (typeof gitDir !== "string" || !path.isAbsolute(gitDir)) {
    return refuse(
      `gitDir must be an absolute path; got ${JSON.stringify(gitDir)}`,
      "no absolute git directory to install into",
    );
  }

  const resolvedDefault = typeof defaultBranch === "string" && defaultBranch.trim().length > 0
    ? defaultBranch.trim()
    : null;

  if (resolvedDefault !== null && !SHELL_SAFE_BRANCH.test(resolvedDefault)) {
    return refuse(
      `default branch ${JSON.stringify(resolvedDefault)} contains characters the generated hook's shell would expand; refusing rather than installing a hook that could execute it or silently guard the wrong branch`,
      "the resolved default branch name is not shell-safe",
    );
  }

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
    // Write + chmod a temp file in the SAME directory, then rename into place.
    // A direct writeFileSync is visible to git mid-write: the common hooks dir
    // is shared, so a concurrent ensureWorktree call (or a real commit racing
    // an install) can exec the file while it is still header-only, falling
    // through to `exit 0` and letting a default-branch commit land. A same-dir
    // rename is atomic, so any reader sees either the old hook or the new one,
    // never a partial one.
    const tmpPath = path.join(hooksDir, `.${hook}.tmp-${process.pid}-${Date.now()}`);
    fs.writeFileSync(tmpPath, renderGuardHook(hook, resolvedDefault), { mode: 0o755 });
    fs.chmodSync(tmpPath, 0o755); // mode above is umask-limited; force it
    fs.renameSync(tmpPath, hookPath);
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
