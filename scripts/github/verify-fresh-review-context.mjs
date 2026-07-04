#!/usr/bin/env node
import { mkdir, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { buildParseError, isDirectCliRun, formatCliError } from "../_core-helpers.mjs";
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
                  When provided, fails closed (exit 1) if the artifact is
                  missing (ENOENT) from the reviewer's cwd. Per-angle
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
Exit codes:
  0  Clean (first run)
  1  Contaminated (prior session detected)
  2  Usage or internal error`.trim();
const VALID_SCOPE_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const parseError = buildParseError(USAGE);
function resolveScope(argv) {
  const idx = argv.indexOf("--scope");
  if (idx === -1) return null;
  const val = argv[idx + 1];
  if (val === undefined || val === "" || (val.length > 0 && val[0] === "-")) {
    return ""; // provided but missing/empty/flag-like
  }
  return val;
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
  const idx = argv.indexOf("--context-path");
  if (idx === -1) return null;
  const val = argv[idx + 1];
  if (val === undefined || val === "" || (val.length > 0 && val[0] === "-")) {
    return ""; // provided but missing/empty/flag-like
  }
  return val;
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
  const round = resolveHeadRound();
  if (contextPathArg !== null) {
    const resolvedContextPath = path.resolve(process.cwd(), contextPathArg);
    try {
      await stat(resolvedContextPath);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      process.stdout.write(JSON.stringify({
        ok: true,
        fresh: false,
        sentinelCreated: false,
        round: round ?? null,
        gateContextPath: contextPathArg,
        gateContextPresent: false,
        reason: `Seeded gate-context artifact missing at "${contextPathArg}" — refusing to review without the build-once neutral context bundle. Per-angle gate reviewers must run in the PR's actual worktree/head (never an isolated worktree checked out from stale main), which is where the context-builder preamble wrote this gitignored artifact.`,
      }) + "\n");
      return 1;
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
    process.stdout.write(JSON.stringify({
      ok: true,
      fresh: false,
      sentinelCreated: false,
      round: round ?? null,
      reason: `Checkpoint context sentinel already exists${existing.legacy ? " (legacy name)" : ""} — inherited session context detected. Restart the subagent with fresh context (subagent({context:\"fresh\"})).`,
    }) + "\n");
    return 1;
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
      process.stdout.write(JSON.stringify({
        ok: true,
        fresh: false,
        sentinelCreated: false,
        round: round ?? null,
        reason: "Checkpoint context sentinel already exists (detected on atomic create) — inherited session context detected. Restart the subagent with fresh context (subagent({context:\"fresh\"})).",
      }) + "\n");
      return 1;
    }
    process.stderr.write(`${formatCliError(err)}\n`);
    return 2;
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    fresh: true,
    sentinelCreated: true,
    round: round ?? null,
    ...(contextPathArg !== null ? { gateContextPath: contextPathArg, gateContextPresent: true } : {}),
  }) + "\n");
  return 0;
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
