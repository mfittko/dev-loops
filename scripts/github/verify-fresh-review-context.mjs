#!/usr/bin/env node
import { mkdir, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { buildParseError, isDirectCliRun, formatCliError } from "../_core-helpers.mjs";
const USAGE = `Usage: verify-fresh-review-context.mjs [--help] [--scope <name>] [--round <token>]
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

Sentinels are per review ROUND, keyed by the head SHA. The round defaults to
the current \`git rev-parse --short HEAD\`, so a retry at a new head naturally
gets a fresh sentinel (no manual clear step) while a same-scope + same-head
re-entry still fails closed. Pass \`--round\` to pin the round explicitly (e.g.
the gate-context head SHA); when git is unavailable the sentinel is keyed by
scope only (legacy behavior).
Options:
  --scope <name>  Unique reviewer scope (e.g. "draft-gate-coverage").
                  Must be non-empty, containing only alphanumeric
                  characters and hyphens. When provided, the sentinel
                  is scoped so parallel reviewers in the same working
                  directory do not trigger false contamination.
  --round <token> Review-round key (e.g. the head SHA). Alphanumeric and
                  hyphens only. Defaults to \`git rev-parse --short HEAD\`;
                  omitted from the key when unset and git is unavailable.
Output (stdout, JSON):
  { "ok": true, "fresh": true, "sentinelCreated": true, "round": "<token|null>" }
  { "ok": true, "fresh": false, "sentinelCreated": false, "round": "...", "reason": "..." }
  On error (stderr, JSON):
  { "ok": false, "error": "...", "usage": "..." }
Exit codes:
  0  Clean (first run)
  1  Contaminated (prior session detected)
  2  Usage or internal error`.trim();
const VALID_SCOPE_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const parseError = buildParseError(USAGE);
function resolveFlag(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  const val = argv[idx + 1];
  if (val === undefined || val === "" || (val.length > 0 && val[0] === "-")) {
    return ""; // provided but missing/empty/flag-like
  }
  return val;
}
function resolveValidatedScope(argv) {
  const raw = resolveFlag(argv, "--scope");
  if (raw === null) return null;
  if (raw === "" || !VALID_SCOPE_RE.test(raw)) {
    process.stderr.write(`${formatCliError(
      parseError(`Invalid --scope value "${raw}": must be non-empty and contain only alphanumeric characters and hyphens.`)
    )}\n`);
    return undefined; // signals invalid
  }
  return raw;
}
// null => auto-resolve from git HEAD; undefined => invalid; string => explicit round
function resolveValidatedRound(argv) {
  const raw = resolveFlag(argv, "--round");
  if (raw === null) return null;
  if (raw === "" || !VALID_SCOPE_RE.test(raw)) {
    process.stderr.write(`${formatCliError(
      parseError(`Invalid --round value "${raw}": must be non-empty and contain only alphanumeric characters and hyphens.`)
    )}\n`);
    return undefined; // signals invalid
  }
  return raw;
}
function resolveHeadRound(cwd = process.cwd()) {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return VALID_SCOPE_RE.test(sha) ? sha : null;
  } catch {
    return null; // not a git repo / git unavailable: legacy scope-only key
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
  const roundArg = resolveValidatedRound(argv);
  if (roundArg === undefined) return 2;
  const round = roundArg === null ? resolveHeadRound() : roundArg;
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
