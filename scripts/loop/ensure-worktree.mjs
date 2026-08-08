#!/usr/bin/env node
/**
 * Ensure a loop-owned worktree exists at its canonical namespaced path, then
 * provision it (issue #909). This is the lifecycle entrypoint: create OR reuse
 * the worktree, then copy/link the configured gitignored files in one step.
 *
 * - Canonical path comes from the shared resolveWorktreePath (namespaced
 *   `tmp/worktrees/dev-loops/<kind>-<n>`), so create/provision/cleanup agree.
 * - `git fetch --prune` every candidate remote (see branchRemoteCandidates)
 *   then `git worktree add` if absent. If a worktree already exists at the
 *   exact path it is REUSED (idempotent); if one exists there on a DIFFERENT
 *   branch it is a hard conflict (we never clobber); if it exists DETACHED
 *   (e.g. ui-review's pinPrHead), it is reused as-is with `branchOrigin:
 *   "reused-detached"` — there is no local branch to associate with a
 *   divergence report.
 * - The branch a fresh worktree is created from depends on what already
 *   exists, never on guessing: an existing LOCAL branch of that name is
 *   re-attached as-is; otherwise the first candidate remote (in priority
 *   order: the one `--base` names, then "origin" when it differs) that
 *   already has a matching REMOTE branch is tracked at its tip (never forked
 *   off base — that would silently drop the remote branch's commits and
 *   point upstream at base instead); only when NO candidate has it is a
 *   genuinely new branch created off the resolved base. See `branchOrigin`
 *   below. Caveat: a `--single-branch` clone only carries remote-tracking
 *   refs for the branches it was cloned with, so a genuinely existing but
 *   never-fetched remote branch can still fall through to created-from-base
 *   there — fetching does not retroactively widen a restricted refspec.
 * - Provisioning is invoked via the imported provisionWorktree core (shared
 *   with provision-worktree.mjs's CLI) — not shelled out. It fails soft: a
 *   provision warning never aborts the worktree.
 * - Does NOT run npm install (out of scope).
 *
 * Prints a JSON result to stdout:
 *   { ok, path, created|reused, base?, branchOrigin, diverged?,
 *     fetchDegraded?, provision: { actions, summary }, guard }
 * (`base` is present only on create — the ref the worktree was created off,
 * see the branch-resolution bullet above and the full USAGE block below.
 * `branchOrigin` is ALWAYS present, on both create and reuse. `diverged` is
 * present, on both create and reuse, only when an existing local branch has
 * genuinely forked from a candidate remote's same-named branch. `fetchDegraded`
 * is present (`true`) only when at least one candidate remote's best-effort
 * fetch failed — the branch resolution above still ran, just against
 * whatever was already fetched. `provision` is the full provisionWorktree()
 * result, not just its summary. `guard` is the default-branch guard's
 * install result — best-effort: a failure there never fails the worktree,
 * see installGuard below.)
 * A git create failure is a hard error (exit 1); provisioning is fail-soft.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePositiveInteger, requireTokenValue } from "../_cli-primitives.mjs";
import { parseArgs } from "node:util";
import { resolveWorktreePath } from "@dev-loops/core/loop/handoff-envelope";
import { normalizeToBareBranch, resolveBaseBranch } from "@dev-loops/core/config";
import { provisionWorktree } from "./provision-worktree.mjs";
import { GUARDED_HOOKS, installDefaultBranchGuard } from "@dev-loops/core/loop/default-branch-guard";
import { canonicalize } from "./_worktree-path.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage:
  ensure-worktree.mjs --repo-root <p> (--issue <n> | --pr <n>) [--branch <name>] [--base <ref>]
Create (or reuse) a loop-owned worktree at its canonical namespaced path
(tmp/worktrees/dev-loops/<kind>-<n>) and provision it in one step.
Required:
  --repo-root <p>   Absolute path to the main checkout (git runs here).
  one of:
  --issue <n>       Issue number (resolves the canonical path).
  --pr <n>          PR number (resolves the canonical path).
Optional:
  --branch <name>   Branch to create/check out (default: <kind>-<n>). A
                     prefixed value is stripped to the bare name — same
                     remote-vs-bare-branch handling as --base: "origin/",
                     "refs/heads/", and "refs/remotes/origin/" always strip,
                     and any OTHER prefix ("upstream/foo") strips only when
                     that first segment is a remote THIS machine has
                     configured.
  --base <ref>      Base ref for a new worktree (default: origin/<repo's
                     auto-detected default branch — origin/HEAD, else
                     main/master; .devloops workflow.baseBranch, when
                     configured, is injected here by the caller as an
                     explicit --base, not self-loaded).
  -h, --help        Show this help.
Output (stdout, JSON):
  { "ok": true, "path": <p>, "created": bool, "reused": bool,
    "base": <ref>,   // present on create: the ref the worktree was created off —
                     // the origin/-prefixed resolved base (default or --base) for
                     // a genuinely new branch, the tracked remote branch
                     // (<remote>/<branch>), or the existing local branch when
                     // re-attached
    "branchOrigin": <str>, // ALWAYS present, on both create and reuse:
                     // "created-from-base" | "tracked-remote" | "reused-local" |
                     // "reused-detached" (an already-existing worktree at this
                     // path with no local branch — e.g. ui-review's pinPrHead)
    "diverged"?: { "remoteRef": <str>, "local": <sha>, "remote": <sha> },
                     // present, on both create and reuse, only when the local
                     // branch has a candidate remote's same-named branch that
                     // has genuinely forked from it (neither is an ancestor of
                     // the other) — the caller decides what to do, this never
                     // silently picks local or remote. Never present for
                     // "reused-detached" (no local branch to compare).
    "fetchDegraded"?: true, // present only when at least one candidate
                     // remote's best-effort fetch failed (offline, unknown
                     // remote, ...) — branch resolution above still ran,
                     // just against whatever was already fetched
    "provision": { "actions": [...], "summary": {...} },
    "guard": { "ok": bool, "installed": [...], "refreshed": [...], "skipped": [...],
               "defaultBranches"?: [...], "droppedExplicitBranches"?: [...],
               "reason"? }                              // default-branch guard
               // install result (best-effort; see installDefaultBranchGuard) —
               // always present, on both the create and reuse paths. Guards the
               // repo's own default AND, when it differs, an explicit --base.
  }

${JQ_OUTPUT_USAGE}`.trim();

const parseError = buildParseError(USAGE);

export function parseEnsureWorktreeCliArgs(argv) {
  const options = {
    help: false,
    repoRoot: undefined,
    issue: undefined,
    pr: undefined,
    branch: undefined,
    // Undefined (not a literal "origin/main"): ensureWorktree() resolves the
    // real default via resolveBaseBranch when no --base is given, so a
    // master-default (or configured-base, injected via explicit --base by the
    // caller) repo gets the right ref instead of a hardcoded "main" guess.
    base: undefined,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      "repo-root": { type: "string" },
      issue: { type: "string" },
      pr: { type: "string" },
      branch: { type: "string" },
      base: { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "positional") throw parseError(`Unknown argument: ${token.value}`);
    if (token.kind !== "option") continue;
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "repo-root") {
      options.repoRoot = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (token.name === "issue") {
      options.issue = parsePositiveInteger(requireTokenValue(token, parseError, { flagPattern: /^-/u }), "--issue", parseError);
      continue;
    }
    if (token.name === "pr") {
      options.pr = parsePositiveInteger(requireTokenValue(token, parseError, { flagPattern: /^-/u }), "--pr", parseError);
      continue;
    }
    if (token.name === "branch") {
      options.branch = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (token.name === "base") {
      options.base = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.help) return options;
  if (!options.repoRoot) throw parseError("Missing required --repo-root");
  const selectors = [options.issue, options.pr].filter((v) => v !== undefined);
  if (selectors.length === 0) throw parseError("One of --issue or --pr is required");
  if (selectors.length > 1) throw parseError("Provide exactly one of --issue or --pr");
  return options;
}

/** Remote name from a base ref like "origin/main" → "origin". */
function remoteFromBase(base) {
  const slash = base.indexOf("/");
  return slash > 0 ? base.slice(0, slash) : "origin";
}

/**
 * Configured remote names (`git remote`), so a slashed `--base` is only ever
 * split into remote/branch when its first segment genuinely names one. A bare
 * `--base release/1.0` (the shape `workflow.baseBranch` documents, "main" or
 * "spike/foo") has no remote named "release" — treating it as one anyway
 * resolves nothing and, before this fix, fed the same wrong remote into the
 * repo's-own-default lookup below.
 */
function listRemotes(gitCommand, cwd) {
  try {
    return runGit(gitCommand, ["remote"], cwd)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function runGit(gitCommand, args, cwd) {
  return execFileSync(gitCommand, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function revParseOrNull(gitCommand, ref, cwd) {
  try {
    return runGit(gitCommand, ["rev-parse", "--verify", "--quiet", ref], cwd).trim();
  } catch {
    return null;
  }
}

/** True when a local branch ref already exists. */
function branchExists(gitCommand, branch, cwd) {
  return revParseOrNull(gitCommand, `refs/heads/${branch}`, cwd) !== null;
}

/**
 * True when `<remote>/<branch>` is a known remote-tracking ref. Guarded
 * against an empty/whitespace branch (`--verify` on a bare `refs/remotes/foo/`
 * throws either way, but a guard reads as intent, not a coincidental catch).
 * Only the REMOTE-tracking ref counts — a local branch of the same name
 * proves nothing about what a remote has: a `master` repo carrying a stale
 * local `main` must not read as "origin has a main branch" (this backs
 * BOTH the branchOrigin lookup and the default-branch guard's own-default
 * resolution below, which used to duplicate this exact check unguarded).
 * `--verify` with the full path also keeps a TAG named `main` from matching.
 */
function remoteBranchExists(gitCommand, remote, branch, cwd) {
  if (typeof branch !== "string" || branch.trim().length === 0) return false;
  try {
    runGit(gitCommand, ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branch.trim()}`], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * True only for a genuine fork (neither ref is an ancestor of the other) —
 * NOT for a plain ahead-or-behind difference, which is the normal state of a
 * local branch carrying commits the remote has not seen yet (or vice versa).
 * Flagging that as "diverged" would fire on every ordinary in-progress branch.
 *
 * `git merge-base --is-ancestor` exit codes: 0 = is an ancestor, 1 = is not —
 * anything else (128: unknown ref, missing objects in a shallow/grafted
 * clone, ...) is a GIT ERROR, not an answer. Treating an error the same as
 * "not an ancestor" fabricated a diverged report out of a broken clone, not a
 * genuine fork — undetermined fails safe to "not diverged" here instead.
 *
 * Exported (in addition to `ensureWorktree`) so this fail-safe distinction is
 * directly testable against a git error (e.g. an unresolvable ref), not just
 * the exit-1 "not an ancestor" case every end-to-end fixture happens to hit.
 */
export function branchesDiverged(gitCommand, localRef, remoteRef, cwd) {
  const isAncestor = (ancestor, descendant) => {
    try {
      runGit(gitCommand, ["merge-base", "--is-ancestor", ancestor, descendant], cwd);
      return true;
    } catch (err) {
      if (err.status === 1) return false;
      throw err;
    }
  };
  try {
    return !isAncestor(localRef, remoteRef) && !isAncestor(remoteRef, localRef);
  } catch {
    return false;
  }
}

/**
 * Remotes to probe for an existing branch, in priority order: the remote
 * `effectiveBase` actually names first (an operator naming `--base
 * upstream/main` is telling us where this worktree's world lives), then
 * "origin" when it differs — so an existing `origin/<branch>` is never
 * invisible just because `--base` pointed at a DIFFERENT remote, which used
 * to silently fork the branch off base with the wrong remote's ref as
 * upstream (the exact clobber this fix exists to prevent). Probing a remote
 * that does not exist is harmless: remoteBranchExists and a fetch of it both
 * fail closed (`false` / a warned, ignored fetch error), never a crash.
 */
function branchRemoteCandidates(baseRemote) {
  return baseRemote === "origin" ? [baseRemote] : [baseRemote, "origin"];
}

/** First candidate remote (in priority order) that already has `branch`, or `null`. */
function findExistingRemoteBranch(gitCommand, root, candidates, branch) {
  return candidates.find((remote) => remoteBranchExists(gitCommand, remote, branch, root)) ?? null;
}

/** Best-effort `git fetch --prune <remote>`; returns false (and warns) on failure. */
function fetchRemoteBestEffort(gitCommand, root, remote) {
  try {
    runGit(gitCommand, ["fetch", "--prune", remote], root);
    return true;
  } catch (err) {
    process.stderr.write(`[ensure-worktree] WARN fetch failed (continuing): ${(err.stderr ?? err.message ?? "").toString().trim()}\n`);
    return false;
  }
}

/**
 * Best-effort fetch every candidate remote; `true` (fetchDegraded) if ANY of
 * them failed. Shared by the create path and the reuse-on-a-local-branch
 * path so both stay in step — a fetch added to one and not the other is
 * exactly the "the same repo state answers differently based on fetch
 * timing" defect the reuse-path fetch itself exists to close.
 */
function fetchCandidatesDegraded(gitCommand, root, candidates) {
  let degraded = false;
  for (const remote of candidates) {
    if (!fetchRemoteBestEffort(gitCommand, root, remote)) degraded = true;
  }
  return degraded;
}

/**
 * Divergence report for the local `branch` against the first of `candidates`
 * (priority order) that already has a matching remote branch, or `undefined`
 * when there is nothing to report (no candidate has the branch, no
 * resolvable SHA, equal SHAs, or a plain ahead/behind difference — not a
 * genuine fork). Shared by BOTH provisioning paths that can land on an
 * already-existing local branch: a fresh worktree re-attaching to one
 * (`branchOrigin: "reused-local"`), and an already-existing worktree being
 * reused outright — a diverged local branch does not stop diverging just
 * because the worktree already existed before this call.
 */
function detectDivergence(gitCommand, root, candidates, branch) {
  const remote = findExistingRemoteBranch(gitCommand, root, candidates, branch);
  if (!remote) return undefined;
  const remoteRef = `${remote}/${branch}`;
  const localSha = revParseOrNull(gitCommand, `refs/heads/${branch}`, root);
  const remoteSha = revParseOrNull(gitCommand, `refs/remotes/${remoteRef}`, root);
  if (!localSha || !remoteSha || localSha === remoteSha) return undefined;
  if (!branchesDiverged(gitCommand, `refs/heads/${branch}`, `refs/remotes/${remoteRef}`, root)) return undefined;
  return { remoteRef, local: localSha, remote: remoteSha };
}

/**
 * Parse `git worktree list --porcelain` into [{ path, branch }]. Branch is the
 * short ref (refs/heads/foo → foo) or null for a detached/bare entry.
 */
function parseWorktreeList(porcelain) {
  const entries = [];
  let cur = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length).trim(), branch: null };
      entries.push(cur);
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  return entries;
}

// Installed at the primary checkout, never in the worktree we just created: the
// guard exists to catch a commit that happens in the WRONG tree. Best-effort by
// design — a repo whose hooks directory is unwritable (or managed by another
// tool) must still get its worktree.
/** Branch name from a base ref like "origin/develop" → "develop". */
function branchFromBase(base) {
  const slash = base.indexOf("/");
  return slash > 0 ? base.slice(slash + 1) : base;
}

/**
 * Split a base ref into the remote it actually names and the bare branch —
 * the ONE place that answers "which remote is this base on". The three
 * prefixes `refs/remotes/origin/`, `refs/heads/`, and `origin/` are ALWAYS
 * stripped first (normalizeToBareBranch, an unconditional string reduction —
 * no remote lookup involved; any other prefix survives). What remains
 * is only EVER further split into remote/branch when its first segment
 * genuinely names a configured remote (`git remote`); a bare slashed branch
 * (the shape `workflow.baseBranch` documents — "main" or "spike/foo", or an
 * unrecognized remote) is NOT split and defaults to "origin" — guessing a
 * remote from an unqualified first segment used to silently point the fetch,
 * and every remote-branch lookup keyed off it, at a remote that does not
 * exist (falling through to created-from-base even when the real remote
 * already had the branch).
 */
function resolveRemoteAndBranch(gitCommand, root, base) {
  const bareBase = normalizeToBareBranch(base);
  const remotes = listRemotes(gitCommand, root);
  const maybeRemote = remoteFromBase(bareBase);
  const isRealRemote = remotes.includes(maybeRemote);
  return {
    remote: isRealRemote ? maybeRemote : "origin",
    branch: isRealRemote ? branchFromBase(bareBase) : bareBase,
  };
}

// Git's OWN advertised default for `remote` — `<remote>/HEAD`, set by every
// real `git clone` (and, empirically, by a plain `git fetch` against a remote
// that itself has one). Deliberately does NOT fall back to guessing
// main-before-master the way resolveBaseBranch's auto-detect does: that guess
// is what let a stale remote `main` out-rank a repo whose real default is
// `master` while still reporting `guard.ok: true` — going inert (the caller
// baking in nothing from this source) is the safe failure here, not a guess.
function remoteAdvertisedDefaultBranch(gitCommand, remote, cwd) {
  try {
    const ref = runGit(gitCommand, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`], cwd).trim();
    const prefix = `${remote}/`;
    return ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
  } catch {
    return null;
  }
}

/**
 * The pre-commit/pre-push hooks live in the ONE common hook directory shared
 * by the primary checkout and every linked worktree — so unlike everything
 * else ensureWorktree does, this is not per-invocation state. Baking in only
 * the per-call `effectiveBase` (an explicit --base, or the resolver's
 * auto-detected guess) would let one `--base origin/develop` call for a
 * stacked worktree REWRITE an already-installed `default="main"` guard to
 * `default="develop"`, after which a commit on the repo's real default
 * silently succeeds while `guard.ok` still reads true.
 *
 * So this always guards the repo's OWN default — resolved fresh from git's
 * advertised `<remote>/HEAD` on every call, never from a guess — and
 * ADDITIONALLY guards an EXPLICIT `--base` (an operator's flag, or the
 * .devloops workflow.baseBranch the resolver injects as one) when it differs.
 * An auto-detected base that was never given explicitly is never trusted for
 * this: trusting it here would bake in the exact same wrong guess it can
 * itself be. The repo default and the explicit base are returned as two
 * SEPARATE fields (not merged into one list) because installDefaultBranchGuard
 * tracks them under different persistence rules: the repo default is unioned
 * across installs (never lost to a transient resolution failure), the
 * explicit base is replaced wholesale by this call's value (so a later call
 * with a different, or no, explicit base can actually drop it — the base's
 * own worktree must be able to commit again once nothing needs it guarded).
 */
function guardedBranches(gitCommand, root, explicitBase) {
  // "origin" unconditionally: the repo's own default must not move just
  // because this particular call's --base happens to name a different
  // remote (or, worse, a bare slashed branch that only LOOKS like one).
  const repoDefaultCandidate = remoteAdvertisedDefaultBranch(gitCommand, "origin", root);
  const repoDefault = repoDefaultCandidate && remoteBranchExists(gitCommand, "origin", repoDefaultCandidate, root)
    ? repoDefaultCandidate
    : null;

  let explicitCandidate = null;
  if (explicitBase) {
    // resolveRemoteAndBranch reduces refs/heads/<b>, refs/remotes/origin/<b>,
    // and origin/<b> to the bare name first (via the same helper
    // resolveBaseBranch already trusts), then only splits off a remote when
    // the first segment is an actually configured one — a hand-rolled
    // remote/branch split used to leave refs/heads/develop and
    // refs/remotes/origin/develop unrecognized (dropping the operator's
    // explicit base unguarded) while origin/HEAD resolved to a phantom "HEAD"
    // branch (a guard for a branch nobody has).
    const { remote, branch } = resolveRemoteAndBranch(gitCommand, root, explicitBase);
    explicitCandidate = branch !== "HEAD" && remoteBranchExists(gitCommand, remote, branch, root) ? branch : null;
  }

  return { repoDefault, explicitBase: explicitCandidate };
}

function installGuard(gitCommand, root, explicitBase) {
  try {
    // The COMMON git dir, not the per-worktree one: `--absolute-git-dir` in a
    // linked worktree resolves to `.git/worktrees/<name>`, a hooks directory git
    // never executes for anything — installing there reports guard.ok: true for
    // a hook that can never fire. `--git-common-dir` is identical for the main
    // checkout and every linked worktree, which is what the hook install must
    // target since hooks are resolved from the common directory.
    // --path-format=absolute needs git >= 2.31; fall back to resolving the
    // (possibly relative) --git-common-dir against the invocation root so an
    // older git still targets the right directory instead of failing the guard.
    let gitDir;
    try {
      gitDir = runGit(gitCommand, ["rev-parse", "--path-format=absolute", "--git-common-dir"], root).trim();
    } catch {
      gitDir = path.resolve(root, runGit(gitCommand, ["rev-parse", "--git-common-dir"], root).trim());
    }
    const { repoDefault, explicitBase: explicitBranch } = guardedBranches(gitCommand, root, explicitBase);
    let hooksPathOverride = null;
    try {
      // Exit 0 means SET (even to ""), exit 1 means unset — `.trim() || null`
      // collapsed both to the same null, so `core.hooksPath=""` (git runs NO
      // hooks at all in that case) read as "unset" and installed hooks git
      // would never execute while reporting guard.ok: true.
      hooksPathOverride = runGit(gitCommand, ["config", "--get", "core.hooksPath"], root).trim();
    } catch {
      hooksPathOverride = null; // unset — `git config --get` exits 1, which is the normal case
    }
    const result = installDefaultBranchGuard({
      gitDir,
      defaultBranches: repoDefault,
      explicitBaseBranches: explicitBranch,
      hooksPathOverride,
    });
    if (!result.ok) {
      // A structured refusal (core.hooksPath set, unsafe branch name, bad
      // gitDir) is otherwise silent: emitResult strips `guard` entirely under
      // --jq/--silent, the documented invocation style, so this stderr line is
      // the only signal an operator gets that nothing was installed.
      process.stderr.write(`[ensure-worktree] WARN default-branch guard not installed: ${result.reason}\n`);
    } else if (result.reason) {
      // ok:true degraded states that carry a reason (a dropped unsafe explicit
      // base, an inert or all-foreign install) surface the same way. A
      // PARTIALLY foreign install carries no reason and stays visible only in
      // guard.skipped.
      process.stderr.write(`[ensure-worktree] WARN default-branch guard degraded: ${result.reason}\n`);
    }
    return result;
  } catch (err) {
    const detail = (err?.stderr ?? err?.message ?? "").toString().trim();
    process.stderr.write(`[ensure-worktree] WARN default-branch guard not installed: ${detail}\n`);
    // Same shape as installDefaultBranchGuard's own refuse(): one skipped
    // entry per guarded hook, not an empty list that reads as "nothing is
    // unguarded" when in fact neither hook could be installed.
    return {
      ok: false,
      installed: [],
      refreshed: [],
      skipped: GUARDED_HOOKS.map((hook) => ({ hook, reason: detail })),
      reason: detail,
    };
  }
}

export async function ensureWorktree(
  { repoRoot, issue, pr, branch, base },
  { gitCommand = "git", provision = provisionWorktree } = {},
) {
  const root = path.resolve(repoRoot);
  // --base/--branch are refs/names an operator (or a config value) may hand
  // in with incidental whitespace — trimmed up front so every use below (the
  // "origin/" prefix match inside resolveRemoteAndBranch included) sees the
  // same value. A PREFIX-ONLY --base ("origin/", "refs/heads/", OR a
  // configured-remote prefix like "upstream/" — resolveRemoteAndBranch, not a
  // bare normalizeToBareBranch, so this catches the same remote prefixes
  // --branch's own emptiness check below does) normalizes to empty — treated
  // as UNSET (falls through to auto-detect below), matching resolveBaseBranch's
  // own documented prefix-only-is-unset contract for a configured
  // workflow.baseBranch value, rather than reaching git as the invalid ref
  // "origin/" ("fatal: invalid reference: origin/").
  if (typeof base === "string") base = base.trim();
  if (typeof base === "string" && resolveRemoteAndBranch(gitCommand, root, base).branch.length === 0) base = undefined;
  const kind = issue !== undefined ? "issue" : "pr";
  const number = issue !== undefined ? issue : pr;
  const target = resolveWorktreePath({ repoRoot: root, kind, number });
  // resolveRemoteAndBranch (not a bare normalizeToBareBranch) so an explicit
  // --branch is ALSO stripped of a configured-remote prefix ("upstream/
  // feature-x" → "feature-x" when "upstream" is a real remote, not just
  // "origin/..."): an explicit --branch is a NAME, not a ref — passing a
  // remote-ref shape by habit used to build a literal nested local branch
  // ("origin/origin/feature-x") below, missing the real remote branch and
  // forking an ambiguous new one off base instead. Falls back to the default
  // name when normalizing collapses to empty ("--branch origin/" strips to
  // "", never a valid branch name).
  const trimmedBranch = typeof branch === "string" ? branch.trim() : "";
  const normalizedBranch = trimmedBranch ? resolveRemoteAndBranch(gitCommand, root, trimmedBranch).branch : "";
  const wantBranch = normalizedBranch || `${kind}-${number}`;
  // No explicit --base: auto-detect the real default branch at `root` (origin/HEAD,
  // else main/master) instead of a hardcoded "origin/main" guess. This script stays
  // a config-agnostic primitive — it never loads .devloops itself; a configured
  // workflow.baseBranch reaches here only via an explicit --base the resolver/skill
  // injects (which always wins over this auto-detected default).
  const effectiveBase = base || `origin/${resolveBaseBranch(undefined, { cwd: root })}`;
  // The remote effectiveBase actually names — validated against `git remote`,
  // never guessed from an unqualified first segment (see resolveRemoteAndBranch)
  // — plus "origin" as a fallback candidate when it differs (see
  // branchRemoteCandidates): an existing origin/<branch> must never be
  // invisible just because --base pointed at a different remote (e.g. a fork
  // workflow's `--base upstream/main`), or the branch is silently forked off
  // base with the WRONG remote as upstream.
  const { remote: baseRemote } = resolveRemoteAndBranch(gitCommand, root, effectiveBase);
  const remoteCandidates = branchRemoteCandidates(baseRemote);

  // Idempotency / conflict check BEFORE any mutation.
  const list = parseWorktreeList(runGit(gitCommand, ["worktree", "list", "--porcelain"], root));
  const canonicalTarget = canonicalize(target);
  const existing = list.find((e) => canonicalize(e.path) === canonicalTarget);
  if (existing) {
    if (existing.branch && existing.branch !== wantBranch) {
      // Hard conflict — never clobber an unrelated worktree at our path.
      throw new Error(
        `worktree conflict: ${target} already checked out on branch "${existing.branch}", not "${wantBranch}"`,
      );
    }
    const summary = await provision({ worktreePath: target, repoRoot: root });
    if (!existing.branch) {
      // DETACHED HEAD (e.g. ui-review's pinPrHead uses `git worktree add
      // --detach`): there is no local branch here to associate a divergence
      // report with — report the honest origin instead of fabricating
      // "reused-local" (or a diverged report) for a branch this worktree
      // isn't even on.
      return {
        ok: true,
        path: target,
        created: false,
        reused: true,
        branchOrigin: "reused-detached",
        provision: summary,
        guard: installGuard(gitCommand, root, base),
      };
    }
    // Reuse: still (re-)provision — provisioning is idempotent. Fetch before
    // the divergence check (mirroring the create path below) so it answers
    // from freshly-fetched remote-tracking refs rather than whatever the
    // operator last happened to fetch — the same repo state must not answer
    // differently purely based on fetch timing.
    const fetchDegraded = fetchCandidatesDegraded(gitCommand, root, remoteCandidates);
    const diverged = detectDivergence(gitCommand, root, remoteCandidates, wantBranch);
    return {
      ok: true,
      path: target,
      created: false,
      reused: true,
      branchOrigin: "reused-local",
      ...(diverged ? { diverged } : {}),
      ...(fetchDegraded ? { fetchDegraded: true } : {}),
      provision: summary,
      guard: installGuard(gitCommand, root, base),
    };
  }

  // Create. fetch is best-effort (offline reuse of a local base ref still works),
  // but `git worktree add` failing is a HARD error.
  const fetchDegraded = fetchCandidatesDegraded(gitCommand, root, remoteCandidates);
  // Three ways the worktree's branch can come into being, in priority order:
  //   1. A LOCAL branch of that name already exists (worktree removed but the
  //      branch left behind) → re-attach to it (`branchOrigin: "reused-local"`).
  //      `git worktree add -b` fails on an existing branch, so this is not
  //      optional — attaching plainly is the only way to reuse it.
  //   2. No local branch, but the first candidate remote (in priority order)
  //      that already has one → check out a NEW local branch tracking THAT
  //      remote's `<name>` at its tip (`branchOrigin: "tracked-remote"`).
  //      Forking a fresh branch off `effectiveBase` here would silently sit
  //      the worktree at base with none of the existing branch's commits,
  //      upstream set to base — one `git push` away from clobbering whatever
  //      the remote branch holds.
  //   3. NO candidate has it → the branch is genuinely new, created off
  //      `effectiveBase` (the origin/-prefixed auto-detected default, or an
  //      explicit --base) (`branchOrigin: "created-from-base"`).
  // Report the ref the worktree was created off, and which of the three paths
  // was taken, so callers/tests can tell them apart.
  let createdBase;
  let branchOrigin;
  let diverged;
  if (branchExists(gitCommand, wantBranch, root)) {
    createdBase = wantBranch;
    branchOrigin = "reused-local";
    runGit(gitCommand, ["worktree", "add", target, wantBranch], root);
    // A local branch that has genuinely forked from a candidate remote's
    // same-named branch is never silently resolved one way or the other —
    // report it so the caller can decide, instead of masking a
    // rewrite-in-progress remote (or a stale local branch) as an ordinary
    // re-attach.
    diverged = detectDivergence(gitCommand, root, remoteCandidates, wantBranch);
  } else {
    const foundRemote = findExistingRemoteBranch(gitCommand, root, remoteCandidates, wantBranch);
    if (foundRemote) {
      const remoteRef = `${foundRemote}/${wantBranch}`;
      createdBase = remoteRef;
      branchOrigin = "tracked-remote";
      runGit(gitCommand, ["worktree", "add", "-b", wantBranch, "--track", target, remoteRef], root);
    } else {
      createdBase = effectiveBase;
      branchOrigin = "created-from-base";
      runGit(gitCommand, ["worktree", "add", "-b", wantBranch, target, effectiveBase], root);
    }
  }

  const summary = await provision({ worktreePath: target, repoRoot: root });
  return {
    ok: true,
    path: target,
    created: true,
    reused: false,
    base: createdBase,
    branchOrigin,
    ...(diverged ? { diverged } : {}),
    ...(fetchDegraded ? { fetchDegraded: true } : {}),
    provision: summary,
    guard: installGuard(gitCommand, root, base),
  };
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const options = parseEnsureWorktreeCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const result = await ensureWorktree(options);
  process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
