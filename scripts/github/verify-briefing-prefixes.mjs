#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";

const USAGE = `Usage: verify-briefing-prefixes.mjs --head-sha <sha> [--help]
Fan-in enforcement for GATE-EXEC-BRIEFING-PREFIX (docs/gate-review-sub-loop-contract.md):
fails closed when this gate-review round's per-scope reviewer sentinels (written by
verify-fresh-review-context.mjs --prefix-hash/--prefix-file) do not all record the SAME
invariant-briefing prefix hash. Deterministic and offline: reads only the sentinel files
already on disk under tmp/, keyed by the given head SHA.

Required:
  --head-sha <sha>  The FULL 40-char reviewed head SHA (git rev-parse HEAD); sentinels are read from
                     tmp/checkpoint-context-sentinel-<scope>-<headSha>.json.

Output (stdout, JSON):
  { "ok": true, "verified": true, "headSha": "...", "reviewerCount": <n>, "prefixHash": "..." }
  { "ok": true, "verified": true, "headSha": "...", "reviewerCount": 0, "reason": "no sentinels found for this round" }
  { "ok": true, "verified": false, "headSha": "...", "reviewerCount": <n>, "reason": "...", "missing": [...], "mismatched": [...] }
  On error (stderr, JSON):
  { "ok": false, "error": "...", "usage": "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Verified: no sentinels found for this round (nothing to check), or every
     sentinel records a hash and all hashes are identical (a single hashed
     sentinel verifies — nothing to mismatch)
  1  Fail closed: two or more sentinels record DIFFERENT prefix hashes, or ANY
     sentinel for the round (even a lone one) records no prefix hash — a missing
     hash is treated as a mismatch, never grandfathered
  2  Usage or internal error, or invalid --jq filter

Caveat: rounds are keyed by head SHA only. Two different gates reviewed at the
SAME head share one sentinel namespace, so run this check (and clear/advance the
head) per gate pass; legitimately different per-gate prefixes at an identical
head would otherwise flag as a mismatch (conservative fail-closed, never
fail-open).`.trim();

// Full 40-char SHA required: sentinel filenames embed the full `git rev-parse
// HEAD` value, so a short prefix would glob zero sentinels and read as a
// vacuous pass — fail closed on anything shorter instead.
const HEAD_SHA_RE = /^[0-9a-f]{40}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SENTINEL_PREFIX = "checkpoint-context-sentinel-";
const parseError = buildParseError(USAGE);

function resolveFlagValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  const val = argv[idx + 1];
  if (val === undefined || val === "" || (val.length > 0 && val[0] === "-")) {
    return ""; // provided but missing/empty/flag-like
  }
  return val;
}

/**
 * Read every sentinel for the given round (head SHA) from `<tmpRoot>/`, extracting
 * the reviewer scope (from the filename) and recorded `prefixHash` (from the JSON
 * body, when present). A malformed/unreadable sentinel is still COUNTED, with
 * `prefixHash: null` — downstream that reads as a missing hash and FAILS CLOSED,
 * deliberately: a corrupt sentinel means the invariant-prefix proof cannot be
 * verified for that reviewer, and silently dropping it would fail open.
 * @param {string} tmpRoot
 * @param {string} headSha — lowercase hex, already validated
 * @returns {Promise<Array<{ scope: string, prefixHash: string|null }>>}
 */
async function readRoundSentinels(tmpRoot, headSha) {
  const suffix = `-${headSha}.json`;
  let entries;
  try {
    entries = await readdir(tmpRoot, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const matches = entries
    .filter((e) => e.isFile() && e.name.startsWith(SENTINEL_PREFIX) && e.name.endsWith(suffix))
    .map((e) => ({
      file: e.name,
      scope: e.name.slice(SENTINEL_PREFIX.length, -suffix.length),
    }))
    .filter((m) => m.scope.length > 0); // exclude the round-only (no-scope) sentinel name shape
  const results = [];
  for (const { file, scope } of matches) {
    let prefixHash = null;
    try {
      const raw = await readFile(path.join(tmpRoot, file), "utf8");
      const parsed = JSON.parse(raw);
      // Only a well-formed sha256 counts as a recorded hash; anything else
      // (corrupted/hand-edited value) is treated as missing so the round
      // fails closed rather than comparing garbage.
      if (parsed && typeof parsed.prefixHash === "string" && SHA256_RE.test(parsed.prefixHash.toLowerCase().trim())) {
        prefixHash = parsed.prefixHash.toLowerCase().trim();
      }
    } catch {
      // Malformed/unreadable sentinel: counted with prefixHash null so the
      // evaluation fails closed on it (see the function doc comment).
    }
    results.push({ scope, prefixHash });
  }
  return results;
}

/**
 * Pure comparison: given the round's sentinels, decide verified/reason/missing/mismatched.
 * Exported for direct unit testing without touching the filesystem.
 * @param {Array<{ scope: string, prefixHash: string|null }>} sentinels
 * @returns {{ verified: boolean, reason?: string, missing?: string[], mismatched?: Array<{scope:string, prefixHash:string}> }}
 */
export function evaluateBriefingPrefixes(sentinels) {
  if (sentinels.length === 0) {
    return { verified: true, reason: "no sentinels found for this round" };
  }
  // A hashless sentinel fails closed even when it is the ONLY sentinel (a
  // one-angle Phase-5 retry round is a real case): "never grandfathered" means
  // the invariant-prefix proof must exist for every reviewer, not just when a
  // sibling exists to compare against. A single HASHED sentinel stays verified —
  // with one recorded hash there is nothing to mismatch.
  const missing = sentinels.filter((s) => s.prefixHash === null).map((s) => s.scope);
  if (missing.length > 0) {
    return {
      verified: false,
      reason: `${missing.length} of ${sentinels.length} reviewer sentinel(s) for this round have no recorded prefix hash — the invariant-briefing-prefix proof (GATE-EXEC-BRIEFING-PREFIX) was never established for them. Missing hashes are treated as a mismatch, not grandfathered in.`,
      missing,
    };
  }
  const distinct = new Map();
  for (const { scope, prefixHash } of sentinels) {
    if (!distinct.has(prefixHash)) distinct.set(prefixHash, []);
    distinct.get(prefixHash).push(scope);
  }
  if (distinct.size > 1) {
    const mismatched = sentinels.map(({ scope, prefixHash }) => ({ scope, prefixHash }));
    return {
      verified: false,
      reason: `Reviewer sentinels for this round recorded ${distinct.size} DIFFERENT invariant-briefing prefix hashes — the seeded briefings were not byte-identical (GATE-EXEC-BRIEFING-PREFIX).`,
      mismatched,
    };
  }
  return { verified: true, prefixHash: sentinels[0].prefixHash };
}

export async function main(argv = process.argv.slice(2), { tmpRoot = path.join(process.cwd(), "tmp") } = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const headShaArg = resolveFlagValue(argv, "--head-sha");
  if (headShaArg === null || headShaArg === "" || !HEAD_SHA_RE.test(headShaArg)) {
    process.stderr.write(`${formatCliError(
      parseError(`--head-sha is required and must be the FULL 40-character hex head SHA (short prefixes would match zero sentinels and pass vacuously)${headShaArg ? ` (got ${JSON.stringify(headShaArg)})` : ""}.`)
    )}\n`);
    return 2;
  }
  const headSha = headShaArg.toLowerCase();
  const jqArg = resolveFlagValue(argv, "--jq");
  if (jqArg === "") {
    process.stderr.write(`${formatCliError(parseError("Invalid --jq value: must be non-empty."))}\n`);
    return 2;
  }
  const jq = jqArg === null ? undefined : jqArg;
  const silent = argv.includes("--silent") || argv.includes("-s");

  const sentinels = await readRoundSentinels(tmpRoot, headSha);
  const verdict = evaluateBriefingPrefixes(sentinels);
  const payload = {
    ok: true,
    verified: verdict.verified,
    headSha,
    reviewerCount: sentinels.length,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
    ...(verdict.missing ? { missing: verdict.missing } : {}),
    ...(verdict.mismatched ? { mismatched: verdict.mismatched } : {}),
    ...(verdict.prefixHash ? { prefixHash: verdict.prefixHash } : {}),
  };
  return emitResult(payload, { jq, silent, ok: verdict.verified });
}

if (isDirectCliRun(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    process.exitCode = 2;
  }
}
