#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { buildParseError, isDirectCliRun, formatCliError } from "../_core-helpers.mjs";
import { JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
const USAGE = `Usage: verify-fresh-review-context.mjs [--help] [--scope <name>] [--context-path <path>]
       [--prefix-hash <sha256>|--prefix-file <path>] [--same-head-retry]
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
  --prefix-hash <sha256>  A 64-character hex SHA-256 digest (case-insensitive,
                  normalized to lowercase) of the
                  invariant briefing block this reviewer was seeded with
                  (GATE-EXEC-BRIEFING-PREFIX in
                  skills/docs/gate-review-sub-loop-contract.md). Recorded on the
                  reviewer's sentinel so \`verify-briefing-prefixes.mjs\` can
                  fail closed when reviewers of the same gate pass were
                  seeded with different invariant blocks. Mutually exclusive
                  with --prefix-file.
  --prefix-file <path>  Path to the invariant briefing block text; the tool
                  hashes its raw bytes (sha256) and records the digest same
                  as --prefix-hash. Fails closed (exit 1) if the file is
                  missing. Mutually exclusive with --prefix-hash.
  --same-head-retry  Sanctioned same-head retry for any scenario that re-runs a
                  reviewer for the SAME scope+head without a rebuilt briefing:
                  a PR-body/description-only fix (which never changes the head
                  SHA), a reviewer interrupted or killed after sentinel
                  creation but before writing its findings artifact, or a
                  harness crash. Requires --prefix-hash/--prefix-file.
                  When a sentinel already exists for this exact scope+round
                  (the normal contamination trip), this flag permits
                  overwriting it ONLY when the given prefix hash matches the
                  existing sentinel's recorded prefix hash exactly — proof
                  the seeded briefing bytes (GATE-EXEC-BRIEFING-PREFIX) were
                  NOT rebuilt, so the round's byte-identity invariant is
                  fully preserved and other clean angles' sentinels from the
                  same round stay valid (no full re-fan required). The reason
                  for the retry never matters; the hash equality is the whole
                  safety argument. A hash MISMATCH (the context-builder WAS
                  re-run) or an existing sentinel with no recorded prefix hash
                  still fails closed — never a general bypass of the
                  contamination guard. See "Sentinel lifecycle" in
                  skills/docs/gate-review-sub-loop-contract.md.
  --pr-body-fix-retry  Deprecated alias for --same-head-retry (identical
                  semantics; kept for existing callers).
Output (stdout, JSON):
  { "ok": true, "fresh": true, "sentinelCreated": true, "round": "<headSha|null>", "repoRoot": "<abs invocation cwd>" }
  { "ok": true, "fresh": true, "sentinelCreated": true, "round": "...", "repoRoot": "...", "gateContextPath": "...", "gateContextPresent": true }
  { "ok": true, "fresh": true, "sentinelCreated": true, "round": "...", "repoRoot": "...", "sameHeadRetry": true, "prBodyFixRetry": true, "prefixHash": "..." }
  { "ok": true, "fresh": false, "sentinelCreated": false, "round": "...", "reason": "..." }
  { "ok": true, "fresh": false, "sentinelCreated": false, "round": "...", "gateContextPath": "...", "gateContextPresent": false, "reason": "..." }
  repoRoot (fresh runs only) is the directory the sentinel ran in. With
  --context-path it is worktree-local (the locality guard proved it); without
  that flag it is simply the invocation cwd, unvalidated. Reviewer shells
  reset cwd between commands, so run every git command as
  \`git -C <repoRoot>\` and read files via absolute paths under it.
  On error (stderr, JSON):
  { "ok": false, "error": "...", "usage": "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Clean (first run), OR a sanctioned --same-head-retry (or its alias
     --pr-body-fix-retry) whose prefix hash matches the existing sentinel's
     recorded hash
  1  Refuse to review: contaminated (prior session detected), OR (with
     --context-path) the seeded gate-context artifact is missing or resolves
     outside the reviewer's working directory, OR (with --prefix-file) the
     prefix file is missing, OR (with --same-head-retry) the existing
     sentinel's recorded prefix hash does not match the given one (or records
     none at all)
  2  Usage or internal error, invalid --jq filter, invalid/conflicting
     --prefix-hash/--prefix-file, or --same-head-retry given without
     --prefix-hash/--prefix-file`.trim();
const VALID_SCOPE_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
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
function resolvePrefixHash(argv) {
  return resolveFlagValue(argv, "--prefix-hash");
}
function resolvePrefixFile(argv) {
  return resolveFlagValue(argv, "--prefix-file");
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
// The live-sentinel filename prefix, owned here by the sentinel producer and
// imported by every consumer that globs sentinels (verify-briefing-prefixes,
// retire-gate-round, write-gate-context's rebuild warning) so the vocabulary
// cannot drift.
export const CHECKPOINT_SENTINEL_PREFIX = "checkpoint-context-sentinel-";

function sentinelRelative(scope, round) {
  const scopeSuffix = scope ? `-${scope}` : "";
  const roundSuffix = round ? `-${round}` : "";
  return path.join("tmp", `${CHECKPOINT_SENTINEL_PREFIX.slice(0, -1)}${scopeSuffix}${roundSuffix}.json`);
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
// Read the recorded `prefixHash` off an existing sentinel file, for the
// --same-head-retry comparison. Returns null on any read/parse failure or
// when the sentinel recorded no (or a malformed) hash — the caller treats
// null as "never grandfathered in", same posture as verify-briefing-prefixes.mjs.
async function readSentinelPrefixHash(sentinelPath) {
  try {
    const raw = await readFile(sentinelPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.prefixHash === "string" && SHA256_HEX_RE.test(parsed.prefixHash.toLowerCase().trim())) {
      return parsed.prefixHash.toLowerCase().trim();
    }
    return null;
  } catch {
    return null;
  }
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
  const prefixHashArg = resolvePrefixHash(argv);
  if (prefixHashArg === "") {
    process.stderr.write(`${formatCliError(
      parseError("Invalid --prefix-hash value: must be non-empty.")
    )}\n`);
    return 2;
  }
  const prefixFileArg = resolvePrefixFile(argv);
  if (prefixFileArg === "") {
    process.stderr.write(`${formatCliError(
      parseError("Invalid --prefix-file value: must be non-empty.")
    )}\n`);
    return 2;
  }
  if (prefixHashArg !== null && prefixFileArg !== null) {
    process.stderr.write(`${formatCliError(
      parseError("--prefix-hash and --prefix-file are mutually exclusive — pass at most one.")
    )}\n`);
    return 2;
  }
  if (prefixHashArg !== null && !SHA256_HEX_RE.test(prefixHashArg.trim().toLowerCase())) {
    process.stderr.write(`${formatCliError(
      parseError(`Invalid --prefix-hash value "${prefixHashArg}": must be a 64-character hex SHA-256 digest (case-insensitive).`)
    )}\n`);
    return 2;
  }
  const sameHeadRetry = argv.includes("--same-head-retry") || argv.includes("--pr-body-fix-retry");
  if (sameHeadRetry && prefixHashArg === null && prefixFileArg === null) {
    process.stderr.write(`${formatCliError(
      parseError("--same-head-retry (alias --pr-body-fix-retry) requires --prefix-hash or --prefix-file (the sanctioned retry proves byte-identity by comparing prefix hashes, so a hash to compare is mandatory).")
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
  // Resolve the invariant-briefing prefix hash (GATE-EXEC-BRIEFING-PREFIX) before
  // sentinel creation, same ordering rationale as --context-path above: a failure
  // here must not burn the scope sentinel.
  let prefixHash = prefixHashArg !== null ? prefixHashArg.trim().toLowerCase() : null;
  if (prefixHash === null && prefixFileArg !== null) {
    let prefixFileBytes;
    try {
      prefixFileBytes = await readFile(path.resolve(process.cwd(), prefixFileArg));
    } catch (err) {
      // ANY read failure (ENOENT, EACCES, EPERM, ...) refuses the review in the
      // normal fail-closed shape — an unreadable prefix file means the
      // invariant-briefing proof cannot be established, which is an enforcement
      // refusal, not a tool crash.
      return finish({
        ok: true,
        fresh: false,
        sentinelCreated: false,
        round: round ?? null,
        reason: `--prefix-file "${prefixFileArg}" unreadable (${err.code ?? "error"}) — cannot compute the invariant-briefing prefix hash (GATE-EXEC-BRIEFING-PREFIX).`,
      }, false);
    }
    prefixHash = createHash("sha256").update(prefixFileBytes).digest("hex");
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
    // Sanctioned same-head retry (skills/docs/gate-review-sub-loop-contract.md,
    // "Sentinel lifecycle"): some legitimate re-runs never earn a new round key
    // — a PR-body/description-only fix (the round is keyed by head SHA, which a
    // body edit never changes), a reviewer interrupted after sentinel creation
    // but before writing its findings artifact, or a harness crash. In all of
    // them a same-scope + same-head re-entry would otherwise trip the
    // contamination guard. Permit ONE narrow exception: overwrite the existing
    // sentinel ONLY when the given prefix hash matches its recorded one exactly —
    // proof the seeded briefing (GATE-EXEC-BRIEFING-PREFIX) was NOT rebuilt, so
    // the round's byte-identity invariant stays fully intact for every other
    // sentinel of this round (no full re-fan needed). The retry's REASON never
    // enters the decision; the hash equality is the whole safety argument. A
    // mismatch (or an existing sentinel recording no prefix hash) still fails
    // closed — never grandfathered.
    if (sameHeadRetry) {
      const existingPrefixHash = await readSentinelPrefixHash(existing.path);
      if (existingPrefixHash !== null && existingPrefixHash === prefixHash) {
        const sentinel = {
          createdAt: new Date().toISOString(),
          pid: process.pid,
          ...(scope ? { scope } : {}),
          ...(round ? { round } : {}),
          prefixHash,
          sameHeadRetry: true,
        };
        try {
          await writeFile(existing.path, JSON.stringify(sentinel, null, 2) + "\n", "utf8");
        } catch (err) {
          process.stderr.write(`${formatCliError(err)}\n`);
          return 2;
        }
        return finish({
          ok: true,
          fresh: true,
          sentinelCreated: true,
          sameHeadRetry: true,
          // Deprecated mirror of sameHeadRetry, kept while callers migrate.
          prBodyFixRetry: true,
          round: round ?? null,
          // See the repoRoot note on the first-run payload below.
          repoRoot: process.cwd(),
          ...(contextPathArg !== null ? { gateContextPath: contextPathArg, gateContextPresent: true } : {}),
          prefixHash,
        }, true);
      }
      return finish({
        ok: true,
        fresh: false,
        sentinelCreated: false,
        round: round ?? null,
        reason: `--same-head-retry refused: the existing sentinel${existingPrefixHash === null ? " recorded no prefix hash" : " recorded a DIFFERENT prefix hash"} — this sanctioned path only covers a same-head retry where the seeded briefing bytes are UNCHANGED (proven by an identical prefix hash). ${existingPrefixHash === null ? "A hashless sentinel is never grandfathered in." : "A changed hash means the context-builder WAS re-run; use the standard head-bump retry instead."}`,
      }, false);
    }
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
    ...(prefixHash ? { prefixHash } : {}),
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
    // The directory this sentinel ran in (worktree-local when the
    // --context-path locality guard passed): reviewer shells reset cwd
    // between commands, so every git command must be `git -C <repoRoot>` and
    // every read an absolute path under it.
    repoRoot: process.cwd(),
    ...(contextPathArg !== null ? { gateContextPath: contextPathArg, gateContextPresent: true } : {}),
    ...(prefixHash ? { prefixHash } : {}),
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
