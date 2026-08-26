#!/usr/bin/env node
/**
 * CLI wrapper for the `postMerge.actions` runner (#1457).
 *
 * Runs a repo's declared `postMerge.actions` (`.devloops`) sequentially, in
 * declared order, with cwd set to the resolved MAIN checkout — never the
 * ambient process cwd. `--repo-root` is only a starting point: this CLI
 * re-derives the actual main checkout via `git worktree list` +
 * `parseMainWorktreePath` (the same resolver `ui-review-provision.mjs` and
 * both harness post-merge hooks use), so an invocation from inside a worktree
 * still lands on the checkout the config/actions apply to.
 *
 * Changed-file scoping (`onlyIfChanged`) resolves the merged PR's changed
 * paths via `gh pr diff <pr> --name-only` (the sanctioned path for this
 * lookup) when `--pr` is given; a missing PR number or a `gh pr diff` failure
 * bypasses scoping (every `onlyIfChanged` action runs unscoped) with a stated
 * reason, never a silent skip (AC5).
 *
 * SECURITY: `run`/`verify` come from the repo's own committed `.devloops`
 * (same trust level as `uiReview.run.command`) and are executed VERBATIM —
 * this CLI never interpolates PR titles, branch names, changed-file paths, or
 * verify output into a command string.
 */
import { execFileSync, spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { loadDevLoopConfig, resolvePostMergeActions } from "@dev-loops/core/config";
import { runPostMergeActions } from "@dev-loops/core/loop/run-post-merge-actions";
import { parseMainWorktreePath } from "@dev-loops/core/loop/worktree-guard";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage:
  run-post-merge-actions.mjs --repo-root <p> [--pr <n>]
Run a repo's declared postMerge.actions (.devloops) sequentially, in order,
after the dev-loop's merge succeeds.
Required:
  --repo-root <p>   Absolute path to a checkout in the repo (the main checkout
                     is re-derived via \`git worktree list\`).
Optional:
  --pr <n>          Merged PR number; resolves onlyIfChanged scoping via
                     \`gh pr diff --name-only\`. Absent scoping bypasses
                     onlyIfChanged actions (they run unscoped) with a warning.
  -h, --help        Show this help.
Output (stdout, JSON):
  { "ok": bool, "results": [{ "name", "status": "ok"|"skipped"|"failed", "detail" }] }
Exit code: non-zero when any action failed; zero when all ran or were skipped cleanly.

${JQ_OUTPUT_USAGE}`.trim();

const parseError = buildParseError(USAGE);

function parsePositiveInt(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw parseError(`${flag} must be a positive integer`);
  return n;
}

export function parseRunPostMergeActionsCliArgs(argv) {
  const options = { help: false, repoRoot: undefined, pr: undefined };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      "repo-root": { type: "string" },
      pr: { type: "string" },
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
    if (token.name === "pr") {
      options.pr = parsePositiveInt(requireTokenValue(token, parseError, { flagPattern: /^-/u }), "--pr");
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.help) return options;
  if (!options.repoRoot) throw parseError("Missing required --repo-root");
  return options;
}

/** Resolve the main checkout from a starting checkout path — never trust cwd. */
function resolveMainCheckout(repoRoot) {
  try {
    const listing = execFileSync("git", ["worktree", "list"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return parseMainWorktreePath(listing) ?? repoRoot;
  } catch {
    return repoRoot;
  }
}

const GH_PR_DIFF_TIMEOUT_MS = 30_000;

/** Resolve the merged PR's changed file paths via `gh pr diff --name-only`, bounded. */
function resolveChangedPaths(cwd, pr) {
  if (pr === undefined) return { changedPaths: null, reason: "no PR number" };
  try {
    const out = execFileSync("gh", ["pr", "diff", String(pr), "--name-only"], {
      cwd,
      encoding: "utf8",
      timeout: GH_PR_DIFF_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const changedPaths = out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    return { changedPaths, reason: null };
  } catch (err) {
    const detail = (err.stderr ?? err.message ?? "gh pr diff failed").toString().trim();
    return { changedPaths: null, reason: `gh pr diff failed: ${detail}` };
  }
}

/** Run `command` in `cwd`, bounded by `timeoutMs`. Never throws. */
function exec(command, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, killed, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, killed, stdout, stderr: err.message ?? String(err) });
    });
  });
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const options = parseRunPostMergeActionsCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }

  const mainCheckout = resolveMainCheckout(options.repoRoot);
  const { config } = await loadDevLoopConfig({ repoRoot: mainCheckout });
  const actions = resolvePostMergeActions(config);

  // No postMerge.actions declared: stay completely silent (no stdout, exit 0) so a
  // repo without this family produces zero observable output from the harness hooks
  // that shell out to this script (AC: zero new commands/log lines when unconfigured).
  if (actions.length === 0) return;

  const { changedPaths, reason } = resolveChangedPaths(mainCheckout, options.pr);
  const result = await runPostMergeActions(
    { actions, changedPaths, changedPathsUnavailableReason: reason ?? "unknown reason", cwd: mainCheckout },
    { exec, log: (msg) => stderr.write(`[run-post-merge-actions] ${msg}\n`) },
  );
  process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
