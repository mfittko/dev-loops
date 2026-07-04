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
 *   { ok, path, created|reused, provision: { actions, summary } }
 * (`provision` is the full provisionWorktree() result, not just its summary.)
 * A git create failure is a hard error (exit 1); provisioning is fail-soft.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { parseArgs } from "node:util";
import { resolveWorktreePath } from "@dev-loops/core/loop/handoff-envelope";
import { provisionWorktree } from "./provision-worktree.mjs";
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
  --base <ref>      Base ref for a new worktree (default: origin/main).
  -h, --help        Show this help.
Output (stdout, JSON):
  { "ok": true, "path": <p>, "created": bool, "reused": bool,
    "provision": { "actions": [...], "summary": {...} } }

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
    base: "origin/main",
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

export async function ensureWorktree(
  { repoRoot, issue, pr, branch, base = "origin/main" },
  { gitCommand = "git", provision = provisionWorktree } = {},
) {
  const root = path.resolve(repoRoot);
  const kind = issue !== undefined ? "issue" : "pr";
  const number = issue !== undefined ? issue : pr;
  const target = resolveWorktreePath({ repoRoot: root, kind, number });
  const wantBranch = branch || `${kind}-${number}`;

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
    return { ok: true, path: target, created: false, reused: true, provision: summary };
  }

  // Create. fetch is best-effort (offline reuse of a local base ref still works),
  // but `git worktree add` failing is a HARD error.
  try {
    runGit(gitCommand, ["fetch", remoteFromBase(base)], root);
  } catch (err) {
    process.stderr.write(`[ensure-worktree] WARN fetch failed (continuing): ${(err.stderr ?? err.message ?? "").toString().trim()}\n`);
  }
  // The branch may already exist (worktree removed but branch left behind). `git
  // worktree add -b` fails on an existing branch, so attach to it instead; only
  // create-from-base when the branch is genuinely new.
  if (branchExists(gitCommand, wantBranch, root)) {
    runGit(gitCommand, ["worktree", "add", target, wantBranch], root);
  } else {
    runGit(gitCommand, ["worktree", "add", "-b", wantBranch, target, base], root);
  }

  const summary = await provision({ worktreePath: target, repoRoot: root });
  return { ok: true, path: target, created: true, reused: false, provision: summary };
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
