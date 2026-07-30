#!/usr/bin/env node
/**
 * Ensure a loop-owned worktree exists at its canonical namespaced path, then
 * provision it (issue #909). This is the lifecycle entrypoint: create OR reuse
 * the worktree, then copy/link the configured gitignored files in one step.
 *
 * - Canonical path comes from the shared resolveWorktreePath (namespaced
 *   `tmp/worktrees/dev-loops/<kind>-<n>`), so create/provision/cleanup agree.
 * - `git fetch <base-origin>` then `git worktree add` if absent. If a worktree
 *   already exists at the exact path it is REUSED (idempotent); if one exists
 *   there on a DIFFERENT branch it is a hard conflict (we never clobber).
 * - Provisioning is invoked via the imported provisionWorktree core (shared
 *   with provision-worktree.mjs's CLI) — not shelled out. It fails soft: a
 *   provision warning never aborts the worktree.
 * - Does NOT run npm install (out of scope).
 *
 * Prints a JSON result to stdout:
 *   { ok, path, created|reused, base?, provision: { actions, summary }, guard }
 * (`provision` is the full provisionWorktree() result, not just its summary.
 * `guard` is the default-branch guard's install result — best-effort: a
 * failure there never fails the worktree, see installGuard below.)
 * A git create failure is a hard error (exit 1); provisioning is fail-soft.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { parseArgs } from "node:util";
import { resolveWorktreePath } from "@dev-loops/core/loop/handoff-envelope";
import { resolveBaseBranch } from "@dev-loops/core/config";
import { provisionWorktree } from "./provision-worktree.mjs";
import { installDefaultBranchGuard } from "@dev-loops/core/loop/default-branch-guard";
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
  --branch <name>   Branch to create/check out (default: <kind>-<n>).
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
                     // a NEW branch, or the existing local branch when re-attached
    "provision": { "actions": [...], "summary": {...} },
    "guard": { "ok": bool, "installed": [...], "refreshed": [...], "skipped": [...],
               "defaultBranch"?, "reason"? }   // default-branch guard install
               // result (best-effort; see installDefaultBranchGuard) — always
               // present, on both the create and reuse paths }

${JQ_OUTPUT_USAGE}`.trim();

const parseError = buildParseError(USAGE);

function parsePositiveInt(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw parseError(`${flag} must be a positive integer`);
  return n;
}

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
      options.issue = parsePositiveInt(requireTokenValue(token, parseError, { flagPattern: /^-/u }), "--issue");
      continue;
    }
    if (token.name === "pr") {
      options.pr = parsePositiveInt(requireTokenValue(token, parseError, { flagPattern: /^-/u }), "--pr");
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

function runGit(gitCommand, args, cwd) {
  return execFileSync(gitCommand, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** True when a local branch ref already exists (non-zero exit → absent). */
function branchExists(gitCommand, branch, cwd) {
  try {
    runGit(gitCommand, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd);
    return true;
  } catch {
    return false;
  }
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

// Only the REMOTE-tracking ref counts. A local branch of the same name proves
// nothing about the remote's default: a `master` repo carrying a stale local
// `main` would otherwise bake in `main`, leaving the real default unguarded
// while reporting success. Requiring `<remote>/<name>` makes that case fall to
// inert, and a repo with no remote is inert too — correctly, since there is no
// remote default to land on. `--verify` with the full path is what keeps a tag
// named `main` from matching.
function remoteDefaultRefExists(gitCommand, remote, branch, cwd) {
  if (typeof branch !== "string" || branch.trim().length === 0) return false;
  try {
    runGit(gitCommand, ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branch.trim()}`], cwd);
    return true;
  } catch {
    return false;
  }
}

function installGuard(gitCommand, root, effectiveBase) {
  try {
    // The COMMON git dir, not the per-worktree one: `--absolute-git-dir` in a
    // linked worktree resolves to `.git/worktrees/<name>`, a hooks directory git
    // never executes for anything — installing there reports guard.ok: true for
    // a hook that can never fire. `--git-common-dir` is identical for the main
    // checkout and every linked worktree, which is what the hook install must
    // target since hooks are resolved from the common directory.
    const gitDir = runGit(gitCommand, ["rev-parse", "--path-format=absolute", "--git-common-dir"], root).trim();
    // Resolve the default at install time and bake it into the hook: deriving
    // it in shell picks a stale local `main` in a `master` repo, guarding the
    // wrong branch while the real default stays open.
    // Reuse the SAME base ensureWorktree already resolved (effectiveBase — the
    // auto-detected default, an explicit --base, or the caller-injected
    // .devloops workflow.baseBranch) instead of re-deriving a bare "main"/
    // "master" guess: re-deriving would guard `main` in a repo based on
    // `develop`, leaving the real base wide open. Confirm the name resolves to
    // a real ref on its own remote; if not, install inert and say so.
    const remote = remoteFromBase(effectiveBase);
    const candidate = branchFromBase(effectiveBase);
    const defaultBranch = remoteDefaultRefExists(gitCommand, remote, candidate, root) ? candidate : null;
    let hooksPathOverride = null;
    try {
      hooksPathOverride = runGit(gitCommand, ["config", "--get", "core.hooksPath"], root).trim() || null;
    } catch {
      hooksPathOverride = null; // unset — `git config --get` exits 1, which is the normal case
    }
    return installDefaultBranchGuard({ gitDir, defaultBranch, hooksPathOverride });
  } catch (err) {
    const detail = (err?.stderr ?? err?.message ?? "").toString().trim();
    process.stderr.write(`[ensure-worktree] WARN default-branch guard not installed: ${detail}\n`);
    // Same shape as the success path (installDefaultBranchGuard's return, and
    // its own refuse()) so a consumer reading `guard.reason`/`guard.installed`
    // does not need a second shape for the "installer itself blew up" case.
    return { ok: false, installed: [], refreshed: [], skipped: [], reason: detail };
  }
}

export async function ensureWorktree(
  { repoRoot, issue, pr, branch, base },
  { gitCommand = "git", provision = provisionWorktree } = {},
) {
  const root = path.resolve(repoRoot);
  const kind = issue !== undefined ? "issue" : "pr";
  const number = issue !== undefined ? issue : pr;
  const target = resolveWorktreePath({ repoRoot: root, kind, number });
  const wantBranch = branch || `${kind}-${number}`;
  // No explicit --base: auto-detect the real default branch at `root` (origin/HEAD,
  // else main/master) instead of a hardcoded "origin/main" guess. This script stays
  // a config-agnostic primitive — it never loads .devloops itself; a configured
  // workflow.baseBranch reaches here only via an explicit --base the resolver/skill
  // injects (which always wins over this auto-detected default).
  const effectiveBase = base || `origin/${resolveBaseBranch(undefined, { cwd: root })}`;

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
    // Reuse: still (re-)provision — provisioning is idempotent.
    const summary = await provision({ worktreePath: target, repoRoot: root });
    return { ok: true, path: target, created: false, reused: true, provision: summary, guard: installGuard(gitCommand, root, effectiveBase) };
  }

  // Create. fetch is best-effort (offline reuse of a local base ref still works),
  // but `git worktree add` failing is a HARD error.
  try {
    runGit(gitCommand, ["fetch", remoteFromBase(effectiveBase)], root);
  } catch (err) {
    process.stderr.write(`[ensure-worktree] WARN fetch failed (continuing): ${(err.stderr ?? err.message ?? "").toString().trim()}\n`);
  }
  // The branch may already exist (worktree removed but branch left behind). `git
  // worktree add -b` fails on an existing branch, so attach to it instead; only
  // create-from-base when the branch is genuinely new.
  // Report the ref the worktree was created off: an already-existing branch is
  // re-attached; a genuinely new branch is created from `effectiveBase` (the
  // origin/-prefixed auto-detected default, or an explicit --base). Lets
  // callers/tests confirm the origin/ prefix was applied to the default.
  let createdBase;
  if (branchExists(gitCommand, wantBranch, root)) {
    createdBase = wantBranch;
    runGit(gitCommand, ["worktree", "add", target, wantBranch], root);
  } else {
    createdBase = effectiveBase;
    runGit(gitCommand, ["worktree", "add", "-b", wantBranch, target, effectiveBase], root);
  }

  const summary = await provision({ worktreePath: target, repoRoot: root });
  return { ok: true, path: target, created: true, reused: false, base: createdBase, provision: summary, guard: installGuard(gitCommand, root, effectiveBase) };
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
