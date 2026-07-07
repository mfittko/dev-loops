#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { GATE_NAMES } from "./_gate-names.mjs";

const USAGE = `Usage: verify-briefing-prefixes.mjs --head-sha <sha> [--help]
Fan-in enforcement for GATE-EXEC-BRIEFING-PREFIX (docs/gate-review-sub-loop-contract.md):
fails closed when a reviewer sentinel's (written by verify-fresh-review-context.mjs
--prefix-hash/--prefix-file) recorded prefix hash matches no on-disk per-gate
briefing-prefix record for this head, matches a DIFFERENT gate than the sentinel's
scope declares, or is missing outright. When no per-gate records exist it falls
back to requiring all of this round's sentinels to share ONE hash. Deterministic
and offline: reads only the sentinel and record files already on disk under tmp/,
keyed by the given head SHA.

Required:
  --head-sha <sha>  The FULL 40-char reviewed head SHA (git rev-parse HEAD); sentinels are read from
                     tmp/checkpoint-context-sentinel-<scope>-<headSha>.json.

Output (stdout, JSON):
  { "ok": true, "verified": true, "headSha": "...", "reviewerCount": <n>, "prefixHash": "..." }
  { "ok": true, "verified": true, "headSha": "...", "reviewerCount": <n>, "prefixHash": "...", "gates": [{ "gate": "draft_gate", "prefixHash": "...", "reviewerCount": <n> }] }
  { "ok": true, "verified": true, "headSha": "...", "reviewerCount": <n>, "gates": [{ "gate": "draft_gate", "prefixHash": "...", "reviewerCount": <n> }, { "gate": "pre_approval_gate", "prefixHash": "...", "reviewerCount": <n> }] }
  { "ok": true, "verified": true, "headSha": "...", "reviewerCount": 0, "reason": "no sentinels found for this round" }
  { "ok": true, "verified": false, "headSha": "...", "reviewerCount": <n>, "reason": "...", "missing": [...], "mismatched": [...] }
  On error (stderr, JSON):
  { "ok": false, "error": "...", "usage": "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Verified: no sentinels found for this round (nothing to check); OR, with
     on-disk per-gate briefing records present, every sentinel's hash matches a
     record AND matches the gate its scope declares (two gates reviewed at one
     head each match their own record, so a verified round can involve
     different per-gate hashes); OR, with no records, all sentinels share one
     identical hash
  1  Fail closed: a sentinel hash matches no on-disk gate record, or matches a
     DIFFERENT gate than its scope declares (wrong-gate briefing), or any
     sentinel records no prefix hash — never grandfathered; or two or more
     sentinels attributed to the SAME gate recorded DIFFERENT prefix hashes
     (within-gate briefings were not byte-identical); or, with no records,
     two or more sentinels record different hashes
  2  Usage or internal error, or invalid --jq filter

Gate scoping: each reviewer sentinel's recorded prefix hash is verified against
the on-disk per-gate briefing-prefix records (<gate>-<headSha>.briefing-prefix.txt
under tmp/gate-context/, written by write-gate-context.mjs). Two gates reviewed
at the SAME head (e.g. a small change clearing draft_gate and pre_approval_gate
without an intervening push) each verify against their own record instead of
colliding into a spurious mismatch, and a hash matching no record fails closed.
A sentinel whose scope self-declares a gate (e.g. "draft-gate-coverage") must
also match THAT gate's record — a hash that matches a DIFFERENT gate's record
is a wrong-gate briefing and fails closed even though the hash itself is known.
Beyond per-sentinel matching, all reviewers attributed to ONE gate must share
ONE identical prefix hash — two DIFFERENT hashes for the same gate fails closed
as a within-gate byte-identity violation, even when each hash individually
matches a known record. When no records are present the check falls back to
the conservative flat rule (all sentinels must share one hash).
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
 * sha256 (the exact bytes reviewers hash via `--prefix-file`) to the set of
 * gate names whose record has that exact hash (normally one gate; a shared
 * hash across gates is possible in principle and must not false-fail the
 * wrong-gate check). These records are the authoritative per-(gate, headSha)
 * proof each reviewer sentinel is verified against — a sentinel hash that
 * matches no record is a contaminated/stale briefing. Empty Map when none
 * exist (offline/legacy), which routes evaluation to the conservative flat
 * fallback.
 * @param {string} tmpRoot
 * @param {string} headSha — lowercase hex, already validated
 * @returns {Promise<Map<string, Set<string>>>} sha256 -> set of gates
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
  const matches = entries
    .filter((e) => e.isFile() && e.name.endsWith(suffix) && e.name.length > suffix.length)
    // readdir order is filesystem-dependent; sort by name so the hash->Set<gate>
    // index is built in a deterministic order across runs.
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const e of matches) {
    const gate = e.name.slice(0, -suffix.length);
    // Only canonical gate records are trusted: a stray/leftover file whose
    // prefix isn't a real gate name must not be able to satisfy record-matching.
    if (!GATE_NAMES.includes(gate)) continue;
    const dir = e.parentPath ?? root;
    let bytes;
    try {
      bytes = await readFile(path.join(dir, e.name));
    } catch {
      continue; // unreadable record: skip; a sentinel relying on it fails closed as unknown
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (!records.has(hash)) records.set(hash, new Set());
    records.get(hash).add(gate);
  }
  return records;
}

/**
 * Gate a reviewer scope self-declares, matched against the canonical gate
 * vocabulary (hyphenated to the `--scope` form, since scopes forbid
 * underscores). Matching is case-insensitive (`--scope` permits mixed case;
 * a mis-cased scope must still be attributed to its gate rather than falling
 * through to the bare-scope path and bypassing the wrong-gate check). Uses
 * the LONGEST matching prefix so a future gate whose name string-extends
 * another is attributed correctly. Returns null for a bare/legacy scope with
 * no recognized gate prefix — those are matched by hash alone.
 * Exported for direct testing.
 * @param {string} scope
 * @param {string[]} [gateNames]
 * @returns {string|null}
 */
export function declaredGateOf(scope, gateNames = GATE_NAMES) {
  const s = scope.toLowerCase();
  let best = null;
  let bestLen = -1;
  for (const gate of gateNames) {
    const prefix = gate.replace(/_/g, "-");
    if ((s === prefix || s.startsWith(`${prefix}-`)) && prefix.length > bestLen) {
      best = gate;
      bestLen = prefix.length;
    }
  }
  return best;
}

/**
 * Pure comparison: decide verified/reason/missing/mismatched for the round.
 * Exported for direct unit testing without touching the filesystem.
 *
 * When `gateRecords` (sha256 -> Set<gate>, from the on-disk `<gate>-<headSha>`
 * briefing-prefix records) is non-empty, EVERY sentinel's recorded prefix hash
 * must match one of those authoritative records; a hash matching none is a
 * contaminated/stale briefing and fails closed. This is what lets two gates
 * legitimately reviewed at ONE head both pass — each verifies against its own
 * gate's record — without a spurious cross-gate mismatch. When a sentinel's
 * scope self-declares a gate (against the canonical GATE_NAMES vocabulary),
 * its matched record's gate set must contain that SAME gate: a known hash that
 * instead belongs only to a different gate's record fails closed as a
 * wrong-gate briefing (the fix for the false fail-closed AND the fail-open the
 * scope-prefix approach would have introduced). Beyond per-sentinel matching,
 * every reviewer attributed to the SAME gate must share ONE identical prefix
 * hash — two distinct hashes for one gate fails closed as a within-gate
 * byte-identity violation (AC2), even though each hash individually matches a
 * known record for that gate. When no records exist (offline/legacy) it falls
 * back to the conservative flat check: all sentinels must share one hash.
 * A missing/hashless sentinel always fails closed (never grandfathered).
 *
 * @param {Array<{ scope: string, prefixHash: string|null }>} sentinels
 * @param {Map<string, Set<string>>|null} [gateRecords] — sha256 -> set of gates
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
  // Record-matching: every sentinel hash must match an on-disk record; a scope
  // that declares a gate must match a record for THAT gate; and all reviewers
  // attributed to one gate must share ONE hash (within-gate byte-identity, AC2).
  const unknown = sentinels.filter((s) => !records.has(s.prefixHash));
  if (unknown.length > 0) {
    return {
      verified: false,
      reason: `${unknown.length} of ${sentinels.length} reviewer sentinel(s) recorded an invariant-briefing prefix hash that matches no gate briefing-prefix record for this head — a contaminated, stale, or hand-edited briefing (GATE-EXEC-BRIEFING-PREFIX). Never grandfathered.`,
      mismatched: unknown.map(({ scope, prefixHash }) => ({ scope, prefixHash })),
    };
  }
  // Attribute each sentinel to a gate and detect wrong-gate briefings.
  const wrongGate = [];
  const attributed = []; // { scope, prefixHash, gate }
  for (const s of sentinels) {
    const gatesForHash = records.get(s.prefixHash); // Set<gate>, non-empty
    const declared = declaredGateOf(s.scope);
    if (declared !== null) {
      if (!gatesForHash.has(declared)) {
        wrongGate.push({ scope: s.scope, prefixHash: s.prefixHash });
        continue;
      }
      attributed.push({ scope: s.scope, prefixHash: s.prefixHash, gate: declared });
    } else {
      // Bare/legacy scope: attribute by the record's gate. A hash mapping to
      // multiple gates (byte-identical briefings across gates — practically
      // impossible since the gate is embedded in the hashed bytes) is resolved
      // deterministically to the alphabetically-first gate for a stable summary.
      const gate = gatesForHash.size === 1 ? [...gatesForHash][0] : [...gatesForHash].sort()[0];
      attributed.push({ scope: s.scope, prefixHash: s.prefixHash, gate });
    }
  }
  if (wrongGate.length > 0) {
    return {
      verified: false,
      reason: `${wrongGate.length} of ${sentinels.length} reviewer sentinel(s) recorded a prefix hash belonging to a DIFFERENT gate than their scope declares — a wrong-gate briefing (GATE-EXEC-BRIEFING-PREFIX).`,
      mismatched: wrongGate,
    };
  }
  // Within-gate byte-identity: every reviewer attributed to one gate must share
  // one hash. Two distinct hashes for the same gate (e.g. multiple same-gate
  // records at this head) fails closed — the byte-identity invariant (AC2).
  const gateHashes = new Map(); // gate -> Set<hash>
  const gateCounts = new Map(); // gate -> count
  for (const a of attributed) {
    if (!gateHashes.has(a.gate)) gateHashes.set(a.gate, new Set());
    gateHashes.get(a.gate).add(a.prefixHash);
    gateCounts.set(a.gate, (gateCounts.get(a.gate) ?? 0) + 1);
  }
  const split = [...gateHashes.entries()].find(([, hs]) => hs.size > 1);
  if (split) {
    const [g] = split;
    return {
      verified: false,
      reason: `Reviewer sentinels for gate ${g} recorded ${split[1].size} DIFFERENT invariant-briefing prefix hashes — within-gate briefings were not byte-identical (GATE-EXEC-BRIEFING-PREFIX).`,
      mismatched: attributed.filter((a) => a.gate === g).map(({ scope, prefixHash }) => ({ scope, prefixHash })),
    };
  }
  const gates = [...gateHashes.entries()]
    .map(([gate, hs]) => ({ gate, prefixHash: [...hs][0], reviewerCount: gateCounts.get(gate) }))
    .sort((a, b) => a.gate.localeCompare(b.gate));
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
