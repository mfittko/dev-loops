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
// pre-merge-commit, not pre-commit, is what git runs for `git merge` (a plain
// `git commit` never fires during a merge); omitting it let a merge onto a
// guarded branch land while a plain commit on the same branch was refused.
export const GUARDED_HOOKS = Object.freeze(["pre-commit", "pre-merge-commit", "pre-push"]);

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
 * Normalize a `defaultBranches` argument (a single branch name, an array of
 * them, or nothing) to a deduped array of trimmed, non-empty strings. More
 * than one branch is guarded when a caller's own default (git's advertised
 * `<remote>/HEAD`) and its resolved working base genuinely differ — e.g. a
 * `.devloops` `workflow.baseBranch` of `develop` in a repo whose real default
 * is still `main`: a stray commit on EITHER must be refused.
 */
function normalizeBranchList(branches) {
  const list = branches == null ? [] : Array.isArray(branches) ? branches : [branches];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * @param {(typeof GUARDED_HOOKS)[number]} hookName one of GUARDED_HOOKS —
 *   "pre-commit", "pre-merge-commit", or "pre-push".
 * @param {string|string[]|null} defaultBranches the STICKY set, resolved at
 *   INSTALL time and unioned across installs by installDefaultBranchGuard.
 *   Baking them in beats re-deriving in shell: `origin/HEAD` is often absent,
 *   and a main-or-master guess picks a stale local `main` in a `master` repo,
 *   which would guard the wrong branch and leave the real default open.
 * @param {string|string[]|null} explicitBranches an operator-scoped set
 *   (e.g. an explicit `--base`) that REPLACES rather than unions across
 *   installs — see installDefaultBranchGuard's explicitBaseBranches.
 * @throws {Error} when hookName is not a guarded hook, or any branch is
 *   non-empty and not shell-safe. `hookName` and every branch name are
 *   interpolated straight into the generated script, so THIS function — not
 *   just its installDefaultBranchGuard caller — is the trust boundary and
 *   must refuse on its own rather than rely on every caller re-checking first.
 */
export function renderGuardHook(hookName, defaultBranches = null, explicitBranches = null) {
  if (!GUARDED_HOOKS.includes(hookName)) {
    throw new Error(`renderGuardHook: unknown hook ${JSON.stringify(hookName)}; expected one of ${GUARDED_HOOKS.join(", ")}`);
  }
  const branches = normalizeBranchList(defaultBranches);
  const explicits = normalizeBranchList(explicitBranches);
  const unsafe = [...branches, ...explicits].find((branch) => !SHELL_SAFE_BRANCH.test(branch));
  if (unsafe) {
    throw new Error(
      `default branch ${JSON.stringify(unsafe)} contains characters the generated hook's shell would expand; refusing to render a hook that could execute it`,
    );
  }
  const defaults = branches.join(" ");
  const explicitDefaults = explicits.join(" ");
  const header = `#!/bin/sh
# ${GUARD_MARKER}
# Refuses a ${hookName} that would land on a guarded default branch. Installed
# in the common hook directory, so linked worktrees run it too — their branch
# is not one of the guarded ones, which is what lets their work through.
if [ "\${${GUARD_OVERRIDE_ENV}}" = "1" ]; then
  exit 0
fi
defaults="${defaults}"
explicit_defaults="${explicitDefaults}"
if [ -z "$defaults" ] && [ -z "$explicit_defaults" ]; then
  # Not resolvable at install time; fail OPEN rather than guess a branch and
  # protect the wrong one. The install reports this so it is not silent.
  exit 0
fi
`;

  // pre-commit and pre-merge-commit both fire with HEAD already on the branch
  // the commit would land on (a plain commit vs. finishing a merge) — same
  // check, just under the name git actually invokes for each operation.
  if (hookName !== "pre-push") {
    return `${header}
# Full ref, not --short: git DISAMBIGUATES a --short symbolic-ref to
# "heads/main" when a tag also named "main" exists, so comparing the short
# form against a bare branch name would never match and let the commit land.
branch=$(git symbolic-ref --quiet HEAD 2>/dev/null) || exit 0
for default in $defaults $explicit_defaults; do
  if [ "$branch" = "refs/heads/$default" ]; then
${REFUSAL_BODY("commit on the default branch", "default")}
    exit 1
  fi
done
exit 0
`;
  }

  // pre-push receives "<local ref> <local sha> <remote ref> <remote sha>" per
  // line on stdin. Checking the CURRENT branch instead would miss every
  // explicit refspec — `git push origin HEAD:main` from a feature branch is the
  // exact shape that moved a remote default in testing.
  return `${header}
blocked=0
blocked_default=""
while read -r local_ref local_sha remote_ref remote_sha; do
  [ -n "$remote_ref" ] || continue
  for default in $defaults $explicit_defaults; do
    if [ "$remote_ref" = "refs/heads/$default" ]; then
      blocked=1
      blocked_default="$default"
    fi
  done
done
if [ "$blocked" = "1" ]; then
${REFUSAL_BODY("push to the default branch", "blocked_default")}
  exit 1
fi
exit 0
`;
}

// Ownership is decided by the marker on a line of its OWN, exactly as the
// renderer emits it. A bare substring test would claim any file that merely
// mentions the sentinel — a user wrapper commented "# chains to
// dev-loops:default-branch-guard" reads as ours and gets overwritten, which is
// the one thing installDefaultBranchGuard promises never to do.
const GUARD_MARKER_LINE = new RegExp(`^# ${GUARD_MARKER}$`, "mu");

/**
 * Pull a baked-in branch list back out of a line this guard itself wrote
 * (`defaults="..."` or `explicit_defaults="..."`), re-validating every entry
 * against SHELL_SAFE_BRANCH rather than trusting the file. A hand-edited (or
 * otherwise corrupted) baked value would otherwise make renderGuardHook THROW
 * on re-install — after earlier hook slots may already have been renamed into
 * place — which breaks the documented "guard.ok: false means nothing was
 * written" invariant. Dropping the unsafe entry here keeps the contract:
 * install refuses on genuinely new bad input, and self-heals a tampered file.
 */
function extractBakedBranches(contents, varName) {
  const match = contents.match(new RegExp(`^${varName}="([^"]*)"$`, "mu"));
  if (!match) return [];
  return match[1].split(/\s+/u).filter((branch) => branch.length > 0 && SHELL_SAFE_BRANCH.test(branch));
}

function readHookState(hookPath) {
  if (!fs.existsSync(hookPath)) return { ours: true, absent: true, existingBranches: [], existingExplicitBranches: [] };
  const contents = fs.readFileSync(hookPath, "utf8");
  const ours = GUARD_MARKER_LINE.test(contents);
  return {
    ours,
    absent: false,
    existingBranches: ours ? extractBakedBranches(contents, "defaults") : [],
    existingExplicitBranches: ours ? extractBakedBranches(contents, "explicit_defaults") : [],
  };
}

/**
 * Install the guard hooks into a repository's hook directory.
 *
 * Idempotent: re-installing rewrites only hooks this guard authored. A hook the
 * user (or another tool) wrote is NEVER clobbered — that file is left exactly as
 * found and reported as `skipped`, because silently replacing someone's hook is
 * a worse failure than not installing ours.
 *
 * `defaultBranches` and `explicitBaseBranches` are tracked as two SEPARATE
 * slots baked into every hook, because they need opposite persistence rules:
 * - `defaultBranches` (a repo's own default) is UNIONED across installs — a
 *   later call resolving fewer/none (a transient fetch hiccup) must never
 *   un-guard a branch an earlier install already protected.
 * - `explicitBaseBranches` (an operator's `--base`, or a configured
 *   `workflow.baseBranch`) is REPLACED wholesale by whatever this call
 *   passes — a later call with a different (or no) explicit base must be
 *   able to replace or drop it, never stack it forever. Unioning this slot
 *   too would permanently guard every branch anyone ever stacked a worktree
 *   off, refusing that branch's OWN commits with no way to undo it.
 *
 * @param {{ gitDir: string, defaultBranches?: string|string[]|null, explicitBaseBranches?: string|string[]|null, hooksPathOverride?: string|null }} target
 *   `hooksPathOverride` is the repo's `core.hooksPath` when set. Installing into
 *   `$GIT_DIR/hooks` while git reads elsewhere would report success for a guard
 *   that can never fire, so that case refuses instead.
 */
export function installDefaultBranchGuard({
  gitDir,
  defaultBranches = null,
  explicitBaseBranches = null,
  hooksPathOverride = null,
}) {
  const refuse = (reason, skipReason) => ({
    ok: false,
    installed: [],
    refreshed: [],
    skipped: GUARDED_HOOKS.map((hook) => ({ hook, reason: skipReason })),
    reason,
  });

  // Any STRING means core.hooksPath is set (`git config --get` exits 0), even
  // to "" — which git treats as "run no hooks at all", not "unset". A caller
  // that collapsed exit-0-empty and exit-1-unset to the same null would make
  // this refusal unreachable for exactly the config value it exists to catch.
  if (typeof hooksPathOverride === "string") {
    const configured = hooksPathOverride.trim();
    return configured.length > 0
      ? refuse(
          `core.hooksPath is set to "${configured}" — install the guard there, or unset it, or use ${GUARD_OVERRIDE_ENV} discipline instead`,
          `core.hooksPath is set to "${configured}", so hooks in $GIT_DIR/hooks would never run`,
        )
      : refuse(
          `core.hooksPath is set to an empty string — git runs no hooks at all; unset it, or use ${GUARD_OVERRIDE_ENV} discipline instead`,
          "core.hooksPath is set to an empty string, so git runs no hooks at all",
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

  // Absoluteness alone does not make it a GIT dir: a caller slip (the worktree
  // root instead of its .git) would otherwise pass, then mkdirSync a stray
  // hooks/ tree there and report success for a guard git will never read.
  // Every real git dir — bare, a main checkout, or a linked worktree's own
  // gitdir — has a HEAD file; that is the cheapest reliable probe.
  if (!fs.existsSync(path.join(gitDir, "HEAD"))) {
    return refuse(
      `gitDir ${JSON.stringify(gitDir)} does not look like a git directory (no HEAD file)`,
      "gitDir does not look like a git directory",
    );
  }

  // A linked worktree's OWN per-worktree gitdir (`.git/worktrees/<name>`) also
  // has a HEAD file, so the probe above alone lets it through — hooks written
  // there are never resolved by git (hooks always come from the COMMON dir),
  // so this would report ok:true for a guard that can never fire. `commondir`
  // exists only in a linked worktree's own gitdir, never in the common one:
  // a one-line, same-cost discriminator against exactly that gitdir.
  if (fs.existsSync(path.join(gitDir, "commondir"))) {
    return refuse(
      `gitDir ${JSON.stringify(gitDir)} is a linked worktree's own git directory, not the common one — hooks installed there never run`,
      "gitDir is a linked worktree's own git directory (has a commondir file), not the common one hooks are resolved from",
    );
  }

  const branches = normalizeBranchList(defaultBranches);
  const explicitBranches = normalizeBranchList(explicitBaseBranches);
  const unsafeBranch = [...branches, ...explicitBranches].find((branch) => !SHELL_SAFE_BRANCH.test(branch));

  if (unsafeBranch) {
    return refuse(
      `default branch ${JSON.stringify(unsafeBranch)} contains characters the generated hook's shell would expand; refusing rather than installing a hook that could execute it or silently guard the wrong branch`,
      "the resolved default branch name is not shell-safe",
    );
  }

  const hooksDir = path.join(gitDir, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });

  // Read every guarded slot's on-disk state ONCE, up front — not inside the
  // write loop — so the union below is computed repo-wide. Computing it
  // per-hook instead let a slot that just became free (a foreign hook
  // removed) miss what its siblings already had baked in, e.g. a hook
  // re-installed after its foreign occupant is gone could get written INERT
  // while its siblings still enforced the real default.
  const hookStates = GUARDED_HOOKS.map((hook) => ({ hook, hookPath: path.join(hooksDir, hook), ...readHookState(path.join(hooksDir, hook)) }));

  // Sticky slot: union across whatever this call resolved (`branches`) with
  // what ANY hook of ours already had baked in — never a straight overwrite.
  // A caller's resolution can legitimately come back empty or narrower on a
  // later call (a transient fetch/network hiccup, a remote HEAD that briefly
  // stopped advertising); rewriting to that smaller set would silently
  // un-guard a branch an earlier install already protected.
  const stickyBranches = new Set(branches);
  for (const state of hookStates) {
    if (!state.ours) continue;
    for (const branch of state.existingBranches) stickyBranches.add(branch);
  }
  const finalStickyBranches = [...stickyBranches];

  // Explicit-base slot: REPLACED wholesale by whatever this call passed, never
  // unioned with what a PRIOR call baked in — that is what makes the slot
  // droppable (a later call with a different, or no, explicit base) instead
  // of accumulating every branch anyone ever stacked a worktree off.
  const finalExplicitBranches = explicitBranches;

  const installed = [];
  const refreshed = [];
  const skipped = [];
  let anyWritten = false;

  for (const state of hookStates) {
    const { hook, hookPath, ours, absent } = state;
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
    fs.writeFileSync(tmpPath, renderGuardHook(hook, finalStickyBranches, finalExplicitBranches), { mode: 0o755 });
    fs.chmodSync(tmpPath, 0o755); // mode above is umask-limited; force it
    fs.renameSync(tmpPath, hookPath);
    anyWritten = true;
    (absent ? installed : refreshed).push(hook);
  }

  // Report only what a hook actually enforces: a branch reads as guarded when
  // at least one slot was WRITTEN with it, never merely requested. Seeding
  // this from `branches` before the loop (the prior bug) claimed enforcement
  // — ok: true, defaultBranches: ["main"] — even when every slot was foreign
  // and nothing was written.
  const reportedBranches = anyWritten ? [...new Set([...finalStickyBranches, ...finalExplicitBranches])] : [];
  let reason;
  if (reportedBranches.length === 0) {
    reason = anyWritten
      ? "default branch could not be resolved at install time; the hooks are inert rather than guessing which branch to protect"
      : "every guarded hook slot is already occupied by a foreign hook; nothing was written, so nothing is enforced";
  }
  return {
    ok: true,
    installed,
    refreshed,
    skipped,
    defaultBranches: reportedBranches,
    ...(reason ? { reason } : {}),
  };
}
