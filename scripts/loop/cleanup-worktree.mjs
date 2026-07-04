#!/usr/bin/env node
/**
 * Namespace-scoped post-merge worktree cleanup (issue #909).
 *
 * Resolves the canonical worktree path via the shared resolver, then runs
 * `git worktree remove --force <path>` + `git worktree prune` from the main
 * checkout (so it never removes the cwd).
 *
 * CLEANUP-SAFETY INVARIANT: refuses to remove any path NOT under
 * `tmp/worktrees/dev-loops/`. A hand-made `tmp/worktrees/my-experiment` can
 * never be force-removed by the loop.
 *
 * FAIL-SOFT: a git error is logged and reported but does NOT fail the process
 * (exit 0 with a reason) so it never breaks a merge-completion flow. Prints a
 * JSON result to stdout.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { parseArgs } from "node:util";
import { resolveWorktreePath, WORKTREE_NAMESPACE } from "@dev-loops/core/loop/handoff-envelope";
import { canonicalize } from "./_worktree-path.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage:
  cleanup-worktree.mjs --repo-root <p> (--issue <n> | --pr <n> | --path <p>)
Remove a loop-owned worktree after merge: git worktree remove --force + prune.
Refuses any path not under ${WORKTREE_NAMESPACE}/.
Required:
  --repo-root <p>   Absolute path to the main checkout (git runs here).
  one of:
  --issue <n>       Issue number (resolves the canonical path).
  --pr <n>          PR number (resolves the canonical path).
  --path <p>        Explicit worktree path (must be under the namespace).
Optional:
  -h, --help        Show this help.
Output (stdout, JSON):
  { "ok": bool, "removed": <path>|null, "reason": "<why>" }
  ok is true on success/skip (incl. fail-soft git errors); false ONLY when the
  path is refused for being outside ${WORKTREE_NAMESPACE}/ (removed: null).

${JQ_OUTPUT_USAGE}`.trim();

const parseError = buildParseError(USAGE);

function parsePositiveInt(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw parseError(`${flag} must be a positive integer`);
  return n;
}

export function parseCleanupWorktreeCliArgs(argv) {
  const options = { help: false, repoRoot: undefined, issue: undefined, pr: undefined, path: undefined };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      "repo-root": { type: "string" },
      issue: { type: "string" },
      pr: { type: "string" },
      path: { type: "string" },
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
    if (token.name === "path") {
      options.path = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.help) return options;
  if (!options.repoRoot) throw parseError("Missing required --repo-root");
  const selectors = [options.issue, options.pr, options.path].filter((v) => v !== undefined);
  if (selectors.length === 0) throw parseError("One of --issue, --pr, or --path is required");
  if (selectors.length > 1) throw parseError("Provide exactly one of --issue, --pr, or --path");
  return options;
}

/**
 * True when `target` is at or under `<repoRoot>/tmp/worktrees/dev-loops/`.
 * Canonicalizes (realpath) every side first: a purely lexical prefix check is
 * bypassable when the namespace dir (or a parent) is a symlink pointing outside
 * the repo — `git worktree remove --force` would then delete outside the repo.
 * Two checks close that hole: (1) the resolved namespace must still live inside
 * the resolved repo-root, and (2) the resolved target must live inside the
 * resolved namespace.
 */
function isUnderNamespace(target, repoRoot) {
  const realRoot = canonicalize(repoRoot);
  const nsRoot = canonicalize(path.join(repoRoot, WORKTREE_NAMESPACE));
  const real = canonicalize(target);
  const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
  // Namespace must resolve inside the repo (refuses a symlinked-out namespace),
  // and the target must resolve inside that namespace.
  return within(nsRoot, realRoot) && within(real, nsRoot);
}

export function cleanupWorktree({ repoRoot, issue, pr, path: explicitPath }, { gitCommand = "git" } = {}) {
  const root = path.resolve(repoRoot);

  let target;
  if (explicitPath !== undefined) {
    target = path.resolve(root, explicitPath);
  } else {
    const kind = issue !== undefined ? "issue" : "pr";
    const number = issue !== undefined ? issue : pr;
    target = resolveWorktreePath({ repoRoot: root, kind, number });
  }

  // Cleanup-safety invariant: only ever remove loop-owned worktrees.
  if (!isUnderNamespace(target, root)) {
    return {
      ok: false,
      removed: null,
      reason: `refused: ${target} is not under ${WORKTREE_NAMESPACE}/`,
    };
  }

  try {
    execFileSync(gitCommand, ["worktree", "remove", "--force", target], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    execFileSync(gitCommand, ["worktree", "prune"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // Fail-soft: never break a merge-completion flow on a git error.
    const detail = (err.stderr ?? err.message ?? "").toString().trim();
    return { ok: true, removed: null, reason: `git error (non-fatal): ${detail}` };
  }

  return { ok: true, removed: target, reason: "removed" };
}

export function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const options = parseCleanupWorktreeCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const result = cleanupWorktree(options);
  // FAIL-SOFT contract (see file header): a parsed command always exits 0 on the
  // non-jq path, even when `ok:false` (path refused) — it must never break a
  // merge-completion caller. Force ok:true here so the default path keeps that
  // contract; --jq/--silent can still read the real `ok` field explicitly.
  process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr, ok: true });
}

if (isDirectCliRun(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  }
}
