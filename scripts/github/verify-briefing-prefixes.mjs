#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
  { "ok": true, "verified": true, "headSha": "...", "reviewerCount": <n>, "gates": [{ "gate": "draft_gate", "prefixHash": "...", "reviewerCount": <n> }, ...] }
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

Gate scoping: each reviewer sentinel's recorded prefix hash is verified against
the on-disk per-gate briefing-prefix records (<gate>-<headSha>.briefing-prefix.txt
under tmp/gate-context/, written by write-gate-context.mjs). Two gates reviewed
at the SAME head (e.g. a small change clearing draft_gate and pre_approval_gate
without an intervening push) each verify against their own record instead of
colliding into a spurious mismatch, and a hash matching no record fails closed
regardless of the reviewer's scope string. When no records are present the check
falls back to the conservative flat rule (all sentinels must share one hash).
Never manually clear sentinels.`.trim();

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
    .filter((m) => m.scope.length > 0) // exclude the round-only (no-scope) sentinel name shape
    // readdir order is filesystem-dependent; sort by scope so missing/mismatched
    // output is deterministic across runs (this is a deterministic fan-in check).
    .sort((a, b) => a.scope.localeCompare(b.scope));
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

const BRIEFING_PREFIX_SUFFIX = ".briefing-prefix.txt";

/**
 * Read the per-gate invariant-briefing records for this head from
 * `<tmpRoot>/gate-context/**` (written by write-gate-context.mjs as
 * `<gate>-<headSha>.briefing-prefix.txt`). Returns a Map from the record's
 * sha256 (the exact bytes reviewers hash via `--prefix-file`) to its gate name.
 * These records are the authoritative per-(gate, headSha) proof each reviewer
 * sentinel is verified against — a sentinel hash that matches no record is a
 * contaminated/stale briefing. Empty Map when none exist (offline/legacy),
 * which routes evaluation to the conservative flat fallback.
 * @param {string} tmpRoot
 * @param {string} headSha — lowercase hex, already validated
 * @returns {Promise<Map<string,string>>} sha256 -> gate
 */
async function readGateBriefingRecords(tmpRoot, headSha) {
  const root = path.join(tmpRoot, "gate-context");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true, recursive: true });
  } catch (err) {
    if (err.code === "ENOENT") return new Map();
    throw err;
  }
  const suffix = `-${headSha}${BRIEFING_PREFIX_SUFFIX}`;
  const records = new Map();
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(suffix)) continue;
    const gate = e.name.slice(0, -suffix.length);
    if (gate.length === 0) continue;
    const dir = e.parentPath ?? e.path ?? root;
    let bytes;
    try {
      bytes = await readFile(path.join(dir, e.name));
    } catch {
      continue; // unreadable record: skip; a sentinel relying on it fails closed as unknown
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (!records.has(hash)) records.set(hash, gate);
  }
  return records;
}

/**
 * Pure comparison: decide verified/reason/missing/mismatched for the round.
 * Exported for direct unit testing without touching the filesystem.
 *
 * When `gateRecords` (sha256 -> gate, from the on-disk `<gate>-<headSha>`
 * briefing-prefix records) is non-empty, EVERY sentinel's recorded prefix hash
 * must match one of those authoritative records; a hash matching none is a
 * contaminated/stale briefing and fails closed. This is what lets two gates
 * legitimately reviewed at ONE head both pass — each verifies against its own
 * gate's record — without a spurious cross-gate mismatch, while a genuinely
 * wrong hash still fails regardless of what scope string the reviewer used
 * (the fix for the false fail-closed AND the fail-open the scope-prefix
 * approach would have introduced). When no records exist (offline/legacy) it
 * falls back to the conservative flat check: all sentinels must share one hash.
 * A missing/hashless sentinel always fails closed (never grandfathered).
 *
 * @param {Array<{ scope: string, prefixHash: string|null }>} sentinels
 * @param {Map<string,string>|null} [gateRecords] — sha256 -> gate
 * @returns {{ verified: boolean, reason?: string, missing?: string[], mismatched?: Array<{scope:string, prefixHash:string}>, prefixHash?: string, gates?: Array<{gate:string, prefixHash:string, reviewerCount:number}> }}
 */
export function evaluateBriefingPrefixes(sentinels, gateRecords = null) {
  if (sentinels.length === 0) {
    return { verified: true, reason: "no sentinels found for this round" };
  }
  const missing = sentinels.filter((s) => s.prefixHash === null).map((s) => s.scope);
  if (missing.length > 0) {
    return {
      verified: false,
      reason: `${missing.length} of ${sentinels.length} reviewer sentinel(s) for this round have no recorded prefix hash — the invariant-briefing-prefix proof (GATE-EXEC-BRIEFING-PREFIX) was never established for them. Missing hashes are treated as a mismatch, not grandfathered in.`,
      missing,
    };
  }
  const records = gateRecords instanceof Map ? gateRecords : new Map();
  if (records.size === 0) {
    // Flat fallback (pre-record behavior, conservative fail-closed): with no
    // authoritative records to attribute sentinels to gates, all sentinels must
    // record ONE identical hash. Two distinct hashes fail closed.
    const distinct = new Map();
    for (const { scope, prefixHash } of sentinels) {
      if (!distinct.has(prefixHash)) distinct.set(prefixHash, []);
      distinct.get(prefixHash).push(scope);
    }
    if (distinct.size > 1) {
      return {
        verified: false,
        reason: `Reviewer sentinels for this round recorded ${distinct.size} DIFFERENT invariant-briefing prefix hashes and no on-disk gate briefing-prefix records were found to attribute them per gate — the seeded briefings were not byte-identical (GATE-EXEC-BRIEFING-PREFIX).`,
        mismatched: sentinels.map(({ scope, prefixHash }) => ({ scope, prefixHash })),
      };
    }
    return { verified: true, prefixHash: sentinels[0].prefixHash };
  }
  // Record-matching: every sentinel hash must match a real (gate, headSha) record.
  const unknown = sentinels.filter((s) => !records.has(s.prefixHash));
  if (unknown.length > 0) {
    return {
      verified: false,
      reason: `${unknown.length} of ${sentinels.length} reviewer sentinel(s) recorded an invariant-briefing prefix hash that matches no gate briefing-prefix record for this head — a contaminated, stale, or hand-edited briefing (GATE-EXEC-BRIEFING-PREFIX). Never grandfathered.`,
      mismatched: unknown.map(({ scope, prefixHash }) => ({ scope, prefixHash })),
    };
  }
  const byGate = new Map();
  for (const { prefixHash } of sentinels) {
    const gate = records.get(prefixHash);
    if (!byGate.has(gate)) byGate.set(gate, { gate, prefixHash, reviewerCount: 0 });
    byGate.get(gate).reviewerCount += 1;
  }
  const gates = [...byGate.values()].sort((a, b) => a.gate.localeCompare(b.gate));
  if (gates.length === 1) {
    return { verified: true, prefixHash: gates[0].prefixHash, gates };
  }
  return { verified: true, gates };
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
  const gateRecords = await readGateBriefingRecords(tmpRoot, headSha);
  const verdict = evaluateBriefingPrefixes(sentinels, gateRecords);
  const payload = {
    ok: true,
    verified: verdict.verified,
    headSha,
    reviewerCount: sentinels.length,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
    ...(verdict.missing ? { missing: verdict.missing } : {}),
    ...(verdict.mismatched ? { mismatched: verdict.mismatched } : {}),
    ...(verdict.prefixHash ? { prefixHash: verdict.prefixHash } : {}),
    ...(verdict.gates ? { gates: verdict.gates } : {}),
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
