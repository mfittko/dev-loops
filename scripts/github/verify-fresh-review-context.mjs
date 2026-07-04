#!/usr/bin/env node
import { mkdir, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { buildParseError, isDirectCliRun, formatCliError } from "../_core-helpers.mjs";
import { JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
const USAGE = `Usage: verify-fresh-review-context.mjs [--help] [--scope <name>] [--context-path <path>]
Verify that the current scoped-reviewer session has fresh context.

"Fresh" means the reviewer's context is the neutral gate-context builder
artifact (the build-once diff + adjacent-code bundle) plus its single review
angle, and explicitly NOT the main (orchestrating) agent's conversation/state
or a prior reviewer session's state. The injected neutral bundle is the
INTENDED seed and is NOT contamination; this guard detects main-agent /
cross-session state bleed by way of a per-(cwd, scope, round) sentinel: a first
run in a fresh session creates the sentinel and passes, a re-entry that finds an
existing sentinel for the same round fails closed. Seeding a reviewer with the
neutral bundle (a path/prompt, not a sentinel) never creates a sentinel, so it
never false-positives as contaminated.

Sentinels are per review ROUND, keyed by the current head SHA (\`git rev-parse
HEAD\`). A retry at a new head naturally gets a fresh sentinel (no manual clear
step), while a same-scope + same-head re-entry still fails closed. When git is
unavailable the sentinel is keyed by scope only (legacy behavior).
Options:
  --scope <name>  Unique reviewer scope (e.g. "draft-gate-coverage").
                  Must be non-empty, containing only alphanumeric
                  characters and hyphens. When provided, the sentinel
                  is scoped so parallel reviewers in the same working
                  directory do not trigger false contamination.
  --context-path <path>  Path to the seeded gate-context artifact this
                  reviewer must be reading from (the build-once bundle
                  written by write-gate-context.mjs, e.g.
                  tmp/gate-context/<repo-slug>/pr-<N>/<gate>-<headSha>.json).
                  Must resolve to a path within the reviewer's working
                  directory; a path that resolves OUTSIDE cwd (an absolute
                  or ..-escaping path pointing at another worktree's bundle,
                  which would defeat the worktree-locality guard) fails
                  closed (exit 1).
                  When provided, also fails closed (exit 1) if the artifact
                  is missing (ENOENT) from the reviewer's cwd. Per-angle
                  gate reviewers must run in the PR's actual worktree/head
                  (never an isolated worktree) so this gitignored,
                  worktree-local artifact is present; a missing artifact
                  means either a stale/isolated checkout or a skipped
                  preamble, and the reviewer must refuse to proceed
                  rather than silently reviewing without seeded context.
Output (stdout, JSON):
  { "ok": true, "fresh": true, "sentinelCreated": true, "round": "<headSha|null>" }
  { "ok": true, "fresh": true, "sentinelCreated": true, "round": "...", "gateContextPath": "...", "gateContextPresent": true }
  { "ok": true, "fresh": false, "sentinelCreated": false, "round": "...", "reason": "..." }
  { "ok": true, "fresh": false, "sentinelCreated": false, "round": "...", "gateContextPath": "...", "gateContextPresent": false, "reason": "..." }
  On error (stderr, JSON):
  { "ok": false, "error": "...", "usage": "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Clean (first run)
  1  Refuse to review: contaminated (prior session detected), OR (with
     --context-path) the seeded gate-context artifact is missing or resolves
     outside the reviewer's working directory
  2  Usage or internal error, or invalid --jq filter`.trim();
const VALID_SCOPE_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const parseError = buildParseError(USAGE);
// Resolve a `--flag <value>` argument. Returns null when the flag is absent,
// "" when it is present but the value is missing/empty/flag-like (a following
// `-`-prefixed token, which must not be silently consumed), else the value.
function resolveFlagValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  const val = argv[idx + 1];
  if (val === undefined || val === "" || (val.length > 0 && val[0] === "-")) {
    return ""; // provided but missing/empty/flag-like
  }
  return val;
}
function resolveScope(argv) {
  return resolveFlagValue(argv, "--scope");
}
function resolveValidatedScope(argv) {
  const raw = resolveScope(argv);
  if (raw === null) return null;
  if (raw === "" || !VALID_SCOPE_RE.test(raw)) {
    process.stderr.write(`${formatCliError(
      parseError(`Invalid --scope value "${raw}": must be non-empty and contain only alphanumeric characters and hyphens.`)
    )}\n`);
    return undefined; // signals invalid
  }
  return raw;
}
function resolveContextPath(argv) {
  return resolveFlagValue(argv, "--context-path");
}
// Round = the current head SHA, so a retry on a new head gets a fresh key while
// a same-head re-entry collides and fails closed. `git rev-parse HEAD` yields the
// same full SHA on every invocation for a given head, so the key is deterministic
// with no user input to spell it inconsistently. Returns null when git is
// unavailable (falls back to the legacy scope-only key).
function resolveHeadRound(cwd = process.cwd()) {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return VALID_SCOPE_RE.test(sha) ? sha : null;
  } catch {
    return null; // not a git repo / git unavailable
  }
}
function sentinelRelative(scope, round) {
  const scopeSuffix = scope ? `-${scope}` : "";
  const roundSuffix = round ? `-${round}` : "";
  return path.join("tmp", `checkpoint-context-sentinel${scopeSuffix}${roundSuffix}.json`);
}
function legacySentinelRelative(scope) {
  const suffix = scope ? `-${scope}` : "";
  return path.join("tmp", `gate-review-context-sentinel${suffix}.json`);
}
async function checkSentinelExists(scope, round, cwd = process.cwd()) {
  const sentinelPath = path.resolve(cwd, sentinelRelative(scope, round));
  try { await stat(sentinelPath); return { exists: true, path: sentinelPath, legacy: false }; } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  // Legacy names predate head-keyed rounds; only consult them for the
  // scope-only key so a stale pre-round sentinel never blocks a new round.
  if (!round) {
    const legacyPath = path.resolve(cwd, legacySentinelRelative(scope));
    try { await stat(legacyPath); return { exists: true, path: legacyPath, legacy: true }; } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  return { exists: false, path: sentinelPath, legacy: false };
}
async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const scope = resolveValidatedScope(argv);
  if (scope === undefined) return 2;
  const contextPathArg = resolveContextPath(argv);
  if (contextPathArg === "") {
    process.stderr.write(`${formatCliError(
      parseError("Invalid --context-path value: must be non-empty.")
    )}\n`);
    return 2;
  }
  const jqArg = resolveFlagValue(argv, "--jq");
  if (jqArg === "") {
    process.stderr.write(`${formatCliError(
      parseError("Invalid --jq value: must be non-empty.")
    )}\n`);
    return 2;
  }
  const jq = jqArg === null ? undefined : jqArg;
  const silent = argv.includes("--silent") || argv.includes("-s");
  // Every branch below reports ok:true (the tool ran successfully); the
  // fresh/contaminated verdict maps to the exit code via `ok` here so the
  // shared --jq/--silent contract composes with the existing 0=fresh/1=refuse
  // signal instead of always reading ok:true as success.
  const finish = (payload, freshLike) => emitResult(payload, { jq, silent, ok: freshLike });
  const round = resolveHeadRound();
  if (contextPathArg !== null) {
    const cwd = process.cwd();
    const resolvedContextPath = path.resolve(cwd, contextPathArg);
    // The guard proves the reviewer is in the working tree where the gitignored
    // tmp/gate-context bundle was written. An absolute or ..-escaping path could
    // stat the real bundle in ANOTHER (stale/isolated) worktree and pass — so a
    // path resolving outside cwd fails closed, defeating that bypass.
    const withinCwd =
      resolvedContextPath === cwd || resolvedContextPath.startsWith(cwd + path.sep);
    if (!withinCwd) {
      return finish({
        ok: true,
        fresh: false,
        sentinelCreated: false,
        round: round ?? null,
        gateContextPath: contextPathArg,
        gateContextPresent: false,
        reason: `Seeded gate-context artifact path "${contextPathArg}" resolves outside the reviewer's working directory — refusing. --context-path must be a cwd-relative path to the worktree-local bundle; an absolute or ..-escaping path could point at another (stale/isolated) worktree's bundle and defeat the worktree-locality guard.`,
      }, false);
    }
    try {
      await stat(resolvedContextPath);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      return finish({
        ok: true,
        fresh: false,
        sentinelCreated: false,
        round: round ?? null,
        gateContextPath: contextPathArg,
        gateContextPresent: false,
        reason: `Seeded gate-context artifact missing at "${contextPathArg}" — refusing to review without the build-once neutral context bundle. Per-angle gate reviewers must run in the PR's actual worktree/head (never an isolated worktree checked out from stale main), which is where the context-builder preamble wrote this gitignored artifact.`,
      }, false);
    }
  }
  const sentinelPath = path.resolve(process.cwd(), sentinelRelative(scope, round));
  try {
    await mkdir(path.dirname(sentinelPath), { recursive: true });
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    return 2;
  }
  const existing = await checkSentinelExists(scope, round);
  if (existing.exists) {
    return finish({
      ok: true,
      fresh: false,
      sentinelCreated: false,
      round: round ?? null,
      reason: `Checkpoint context sentinel already exists${existing.legacy ? " (legacy name)" : ""} — inherited session context detected. Restart the subagent with fresh context (subagent({context:\"fresh\"})).`,
    }, false);
  }
  const sentinel = {
    createdAt: new Date().toISOString(),
    pid: process.pid,
    ...(scope ? { scope } : {}),
    ...(round ? { round } : {}),
  };
  try {
    await writeFile(sentinelPath, JSON.stringify(sentinel, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (err) {
    if (err.code === "EEXIST") {
      return finish({
        ok: true,
        fresh: false,
        sentinelCreated: false,
        round: round ?? null,
        reason: "Checkpoint context sentinel already exists (detected on atomic create) — inherited session context detected. Restart the subagent with fresh context (subagent({context:\"fresh\"})).",
      }, false);
    }
    process.stderr.write(`${formatCliError(err)}\n`);
    return 2;
  }
  return finish({
    ok: true,
    fresh: true,
    sentinelCreated: true,
    round: round ?? null,
    ...(contextPathArg !== null ? { gateContextPath: contextPathArg, gateContextPresent: true } : {}),
  }, true);
}
if (isDirectCliRun(import.meta.url)) {
  try {
    const exitCode = await main();
    process.exitCode = exitCode;
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    process.exitCode = 2;
  }
}
