#!/usr/bin/env node
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildParseError, isDirectCliRun, formatCliError } from "../_core-helpers.mjs";
const USAGE = `Usage: verify-fresh-review-context.mjs [--help] [--scope <name>]
Verify that the current scoped-reviewer session has fresh context.

"Fresh" means the reviewer's context is the neutral gate-context builder
artifact (the build-once diff + adjacent-code bundle) plus its single review
angle, and explicitly NOT the main (orchestrating) agent's conversation/state
or a prior reviewer session's state. The injected neutral bundle is the
INTENDED seed and is NOT contamination; this guard detects main-agent /
cross-session state bleed by way of a per-(cwd, scope) sentinel: a first run in
a fresh session creates the sentinel and passes, a re-entry that finds an
existing sentinel fails closed. Seeding a reviewer with the neutral bundle (a
path/prompt, not a sentinel) never creates a sentinel, so it never
false-positives as contaminated.
Options:
  --scope <name>  Unique reviewer scope (e.g. "draft-gate-coverage").
                  Must be non-empty, containing only alphanumeric
                  characters and hyphens. When provided, the sentinel
                  is scoped so parallel reviewers in the same working
                  directory do not trigger false contamination.
Output (stdout, JSON):
  { "ok": true, "fresh": true, "sentinelCreated": true }
  { "ok": true, "fresh": false, "sentinelCreated": false, "reason": "..." }
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
function sentinelRelative(scope) {
  const suffix = scope ? `-${scope}` : "";
  return path.join("tmp", `checkpoint-context-sentinel${suffix}.json`);
}
function legacySentinelRelative(scope) {
  const suffix = scope ? `-${scope}` : "";
  return path.join("tmp", `gate-review-context-sentinel${suffix}.json`);
}
async function checkSentinelExists(scope, cwd = process.cwd()) {
  const sentinelPath = path.resolve(cwd, sentinelRelative(scope));
  try { await stat(sentinelPath); return { exists: true, path: sentinelPath, legacy: false }; } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const legacyPath = path.resolve(cwd, legacySentinelRelative(scope));
  try { await stat(legacyPath); return { exists: true, path: legacyPath, legacy: true }; } catch (err) {
    if (err.code !== "ENOENT") throw err;
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
  const sentinelPath = path.resolve(process.cwd(), sentinelRelative(scope));
  try {
    await mkdir(path.dirname(sentinelPath), { recursive: true });
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    return 2;
  }
  const existing = await checkSentinelExists(scope);
  if (existing.exists) {
    process.stdout.write(JSON.stringify({
      ok: true,
      fresh: false,
      sentinelCreated: false,
      reason: `Checkpoint context sentinel already exists${existing.legacy ? " (legacy name)" : ""} — inherited session context detected. Restart the subagent with fresh context (subagent({context:\"fresh\"})).`,
    }) + "\n");
    return 1;
  }
  const sentinel = {
    createdAt: new Date().toISOString(),
    pid: process.pid,
    ...(scope ? { scope } : {}),
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
