#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { verifyPromptLeadingAlignment, sha256Hex } from "@dev-loops/core/loop/review-dispatch-plan";
import { validateBriefingPrefixPath } from "./record-dispatch-prompt-layout.mjs";

const USAGE = `Usage: verify-dispatch-prompt-layout.mjs --head-sha <sha> [--tmp-root <path>] [--help]
Fan-in enforcement of the reviewer-PROMPT provenance half of GATE-EXEC-FANOUT-DISPATCH-EMIT
/ GATE-EXEC-BRIEFING-PREFIX (skills/docs/gate-review-sub-loop-contract.md):
verify-briefing-prefixes.mjs proves the recorded prefix HASH is byte-identical
across a round's reviewer sentinels, but proves nothing about whether any
reviewer's ACTUAL prompt was the sanctioned emitter's emitted unit. This checker
reads the dispatch records record-dispatch-prompt-layout.mjs writes at fan-out and
fails closed (exit 1) unless each present record BINDS to the sanctioned emitter's
emitted unit:
  1. its recorded full-content hash (promptContentHash) equals the hash of the
     canonical \`<gate>-<headSha>.dispatch-prompt-<scope>.txt\` emitted file, and
  2. that emitted file LEADS with the round's byte-identical invariant prefix
     INLINE (never angle-first, never pointer-seeded).
This rejects the three failure modes prose discipline never held: a hand-composed
pointer-seeding prompt, a paraphrased/altered suffix (a matching invariant prefix
does NOT prove an unchanged suffix), and any mismatched delivered prompt. It binds
recorded-layout identity to generated-file identity; it does NOT prove
delivered-task identity — whether the spawned subagent actually received those
bytes is the orchestrating-agent relay hop, which no Claude Code Agent-tool
primitive exposes for independent verification (documented best-effort boundary,
see GATE-EXEC-BRIEFING-PREFIX "Per-harness delivery").

Ground truth is ALWAYS re-discovered on disk here (never trusted from a record's
own stored path): each record's prefix basename names a (gate, headSha) pair, and
this checker independently locates that gate's real
\`<tmp-root>/gate-context/**/<gate>-<headSha>.briefing-prefix.txt\` and its sibling
\`<gate>-<headSha>.dispatch-prompt-<scope>.txt\` emitted file to read their bytes.

Required:
  --head-sha <sha>  The FULL 40- or 64-char reviewed head SHA (git rev-parse HEAD);
                     dispatch-prompt records are read from
                     tmp/checkpoint-dispatch-prompt-<scope>-<headSha>.json.
Optional:
  --tmp-root <path>  The tmp/ directory to read records/gate-context from (default: process.cwd()/tmp).
Output (stdout, JSON):
  { "ok": true, "verified": true, "headSha": "...", "recordCount": <n>, "reason"?: "no dispatch-prompt records found for this round" }
  { "ok": true, "verified": false, "headSha": "...", "recordCount": <n>, "reason": "...", "misaligned": [{ "scope", "reason" }] }
  On error (stderr, JSON):
  { "ok": false, "error": "...", "usage": "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Verified: no dispatch-prompt records found for this round (progressive/optional
     capture — a round the orchestrator has not yet been updated to capture never
     newly blocks), OR every present record binds to the sanctioned inline-aligned emitted unit
  1  Fail closed: at least one present record does NOT bind to the sanctioned emitter's
     emitted unit — a missing full-content hash, no canonical emitted file on disk,
     a hash mismatch (altered suffix / mismatched delivered / hand-composed prompt),
     an emitted unit that is not inline-aligned, or a "prefixPath" basename that no
     longer names a real on-disk gate-context record
  2  Usage or internal error, or invalid --jq filter`.trim();

const HEAD_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const RECORD_PREFIX = "checkpoint-dispatch-prompt-";
const parseError = buildParseError(USAGE);

function resolveFlagValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  const val = argv[idx + 1];
  if (val === undefined || val === "" || (val.length > 0 && val[0] === "-")) return "";
  return val;
}

/**
 * Read every dispatch-prompt-layout record for this round (head SHA) from
 * `<tmpRoot>/`. A malformed/unreadable record is still counted, with
 * `leading: null` — downstream fails closed on it, deliberately (mirrors
 * verify-briefing-prefixes.mjs's own malformed-sentinel posture): a corrupt
 * record means the prompt-layout proof cannot be verified for that reviewer.
 * @param {string} tmpRoot
 * @param {string} headSha — lowercase hex, already validated
 * @returns {Promise<Array<{ scope: string, prefixPath: string|null, leading: string|null, promptContentHash: string|null }>>}
 */
async function readDispatchPromptRecords(tmpRoot, headSha) {
  const suffix = `-${headSha}.json`;
  let entries;
  try {
    entries = await readdir(tmpRoot, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const matches = entries
    .filter((e) => e.isFile() && e.name.startsWith(RECORD_PREFIX) && e.name.endsWith(suffix))
    .map((e) => ({ file: e.name, scope: e.name.slice(RECORD_PREFIX.length, -suffix.length) }))
    .filter((m) => m.scope.length > 0)
    .sort((a, b) => a.scope.localeCompare(b.scope));
  const results = [];
  for (const { file, scope } of matches) {
    try {
      const raw = await readFile(path.join(tmpRoot, file), "utf8");
      const parsed = JSON.parse(raw);
      const prefixPath = typeof parsed?.prefixPath === "string" && parsed.prefixPath.length > 0 ? parsed.prefixPath : null;
      const leading = typeof parsed?.leading === "string" ? parsed.leading : null;
      const promptContentHash = typeof parsed?.promptContentHash === "string" && parsed.promptContentHash.length > 0 ? parsed.promptContentHash : null;
      results.push({ scope, prefixPath, leading, promptContentHash });
    } catch {
      results.push({ scope, prefixPath: null, leading: null, promptContentHash: null });
    }
  }
  return results;
}

/**
 * Re-discover the REAL on-disk invariant-prefix bytes for `gate`/`headSha`
 * under `<tmpRoot>/gate-context/**` (write-gate-context.mjs's
 * `<gate>-<headSha>.briefing-prefix.txt`, the same record
 * verify-briefing-prefixes.mjs treats as authoritative) — never the caller's
 * stored path, so a dispatch-prompt record naming a stale/tampered directory
 * can never smuggle in different ground-truth bytes. Returns `null` when no
 * such record exists.
 * @param {string} tmpRoot
 * @param {string} gate
 * @param {string} headSha — lowercase hex, already validated
 * @returns {Promise<string|null>}
 */
async function findGateBriefingPrefixBytes(tmpRoot, gate, headSha) {
  const root = path.join(tmpRoot, "gate-context");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true, recursive: true });
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  const targetName = `${gate}-${headSha}.briefing-prefix.txt`;
  const matches = entries
    .filter((e) => e.isFile() && e.name === targetName)
    .sort((a, b) => (a.parentPath ?? "").localeCompare(b.parentPath ?? ""));
  if (matches.length === 0) return null;
  const dir = matches[0].parentPath ?? root;
  try {
    return await readFile(path.join(dir, targetName), "utf8");
  } catch {
    return null;
  }
}

/**
 * Re-discover the sanctioned emitter's canonical emitted-prompt FILE for
 * `gate`/`scope`/`headSha` on disk — the `<gate>-<headSha>.dispatch-prompt-<scope>.txt`
 * file `compose-reviewer-prompt.mjs`/`emit-fanout-dispatch.mjs` write next to the
 * invariant prefix. Located by name under `<tmpRoot>/gate-context/**`, NEVER
 * trusted from the record's own stored path (same posture as
 * `findGateBriefingPrefixBytes`), so a record cannot point the binding check at
 * an arbitrary file. Returns the emitted bytes, or `null` when no such emitted
 * file exists (a dispatch that did NOT go through the sanctioned emitter — its
 * provenance cannot be verified, so the caller fails closed).
 * @param {string} tmpRoot
 * @param {string} gate
 * @param {string} scope
 * @param {string} headSha — lowercase hex, already validated
 * @returns {Promise<string|null>}
 */
async function findEmittedPromptBytes(tmpRoot, gate, scope, headSha) {
  const root = path.join(tmpRoot, "gate-context");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true, recursive: true });
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  const targetName = `${gate}-${headSha}.dispatch-prompt-${scope}.txt`;
  const matches = entries
    .filter((e) => e.isFile() && e.name === targetName)
    .sort((a, b) => (a.parentPath ?? "").localeCompare(b.parentPath ?? ""));
  if (matches.length === 0) return null;
  const dir = matches[0].parentPath ?? root;
  try {
    return await readFile(path.join(dir, targetName), "utf8");
  } catch {
    return null;
  }
}

/**
 * Pure comparison over already-read records + already-read prefix bytes + the
 * RE-DISCOVERED sanctioned emitted-unit bytes for each record's scope. Exported
 * for direct unit testing without touching the filesystem.
 *
 * Each present record must BIND to the sanctioned emitter's emitted unit
 * (GATE-EXEC-FANOUT-DISPATCH-EMIT): the record's full-content hash must equal
 * the emitted file's hash, and that emitted file must lead with the round's
 * invariant prefix INLINE. This rejects a hand-composed pointer-seeding prompt,
 * a paraphrased/altered suffix, and any mismatched delivered prompt — none of
 * which reproduce the emitted unit's bytes. It binds recorded-layout identity to
 * generated-file identity; it does NOT prove delivered-task identity (that the
 * subagent actually received the bytes) — that hop is the documented best-effort
 * boundary (see GATE-EXEC-BRIEFING-PREFIX "Per-harness delivery").
 *
 * @param {Array<{ scope: string, prefixPath: string|null, leading: string|null, promptContentHash: string|null }>} records
 * @param {Map<string, string>} prefixBytesByPath — record's raw "prefixPath" string -> the RE-DISCOVERED real prefix bytes for its (gate, headSha)
 * @param {Map<string, { contentHash: string|null, inlineAligned: boolean }>} emittedByScope — record scope -> the RE-DISCOVERED emitted unit's full-content hash and whether it leads with the invariant prefix inline; absent scope means no emitted file was found
 * @returns {{ verified: boolean, reason?: string, misaligned?: Array<{scope:string, reason:string}> }}
 */
export function evaluateDispatchPromptLayout(records, prefixBytesByPath, emittedByScope = new Map()) {
  if (records.length === 0) {
    return { verified: true, reason: "no dispatch-prompt records found for this round" };
  }
  const misaligned = [];
  for (const r of records) {
    if (r.prefixPath === null || r.leading === null) {
      misaligned.push({ scope: r.scope, reason: "dispatch-prompt record is missing/malformed (no recorded prefixPath or leading bytes) — never grandfathered in" });
      continue;
    }
    const prefixBytes = prefixBytesByPath.get(r.prefixPath);
    if (prefixBytes === undefined) {
      misaligned.push({ scope: r.scope, reason: `recorded "prefixPath" ${JSON.stringify(r.prefixPath)} no longer names a real on-disk gate-context briefing-prefix record` });
      continue;
    }
    // A present record with no full-content hash cannot bind to the emitted unit
    // — a coordinator-authored record cannot prove emitted-unit provenance on its
    // own. Never grandfathered (same fail-closed posture as a null prefixPath).
    if (r.promptContentHash === null) {
      misaligned.push({ scope: r.scope, reason: "dispatch-prompt record carries no promptContentHash — a coordinator-authored record cannot prove it binds to the sanctioned emitter's emitted unit (GATE-EXEC-FANOUT-DISPATCH-EMIT); never grandfathered in" });
      continue;
    }
    const emitted = emittedByScope.get(r.scope);
    if (emitted === undefined || emitted.contentHash === null) {
      misaligned.push({ scope: r.scope, reason: `no sanctioned emitter emitted-prompt file (<gate>-<headSha>.dispatch-prompt-${r.scope}.txt) found on disk for this record — a dispatch not produced by emit-fanout-dispatch.mjs / compose-reviewer-prompt.mjs cannot bind its provenance to an emitted unit (GATE-EXEC-FANOUT-DISPATCH-EMIT)` });
      continue;
    }
    if (emitted.contentHash !== r.promptContentHash) {
      misaligned.push({ scope: r.scope, reason: "recorded prompt bytes do not match the sanctioned emitter's emitted unit (altered/paraphrased suffix, a mismatched delivered prompt, or a hand-composed prompt) — a matching invariant prefix does not prove an unchanged suffix (GATE-EXEC-FANOUT-DISPATCH-EMIT)" });
      continue;
    }
    if (!emitted.inlineAligned) {
      misaligned.push({ scope: r.scope, reason: "the emitted unit does not LEAD with the round's byte-identical invariant prefix INLINE (angle-first or pointer-seeded emitted prompt) — GATE-EXEC-BRIEFING-PREFIX requires the invariant prefix inlined as the emitted prompt's leading bytes" });
      continue;
    }
  }
  if (misaligned.length > 0) {
    return {
      verified: false,
      reason: `${misaligned.length} of ${records.length} dispatched reviewer prompt(s) for this round do not bind to the sanctioned emitter's inline-aligned emitted unit (GATE-EXEC-FANOUT-DISPATCH-EMIT / GATE-EXEC-BRIEFING-PREFIX) — hand-composed pointer seeding, an altered suffix, or a mismatched delivered prompt cannot satisfy a clean gate.`,
      misaligned,
    };
  }
  return { verified: true };
}

/**
 * Programmatic entry: read this round's dispatch-prompt records, re-discover
 * each record's REAL on-disk (gate, headSha) prefix bytes on disk (never the
 * record's own stored path), and return the verdict
 * `evaluateDispatchPromptLayout` produces. Used by `consolidate-fanin.mjs`
 * (Phase 3 fan-in) alongside `verifyBriefingPrefixesForHead`.
 * @param {string} tmpRoot
 * @param {string} headSha — already lowercased/trimmed by the caller
 * @returns {Promise<object>}
 */
export async function verifyDispatchPromptLayoutForHead(tmpRoot, headSha) {
  const records = await readDispatchPromptRecords(tmpRoot, headSha);
  const prefixBytesByPath = new Map();
  const emittedByScope = new Map();
  for (const r of records) {
    if (r.prefixPath === null) continue;
    const check = validateBriefingPrefixPath(r.prefixPath, headSha);
    if (!check.ok) continue; // left unset -> evaluateDispatchPromptLayout fails closed on it
    if (!prefixBytesByPath.has(r.prefixPath)) {
      const bytes = await findGateBriefingPrefixBytes(tmpRoot, check.gate, headSha);
      if (bytes !== null) prefixBytesByPath.set(r.prefixPath, bytes);
    }
    // Re-discover the sanctioned emitter's emitted unit on disk (never trusted
    // from the record's own path) and bind the record to it by full-content
    // hash + INLINE prefix alignment. A record whose emitted file is missing,
    // whose bytes differ, or that is not inline-aligned fails closed.
    if (!emittedByScope.has(r.scope)) {
      const prefixBytes = prefixBytesByPath.get(r.prefixPath);
      const emittedBytes = await findEmittedPromptBytes(tmpRoot, check.gate, r.scope, headSha);
      if (emittedBytes === null || prefixBytes === undefined) {
        emittedByScope.set(r.scope, { contentHash: null, inlineAligned: false });
      } else {
        const verdict = verifyPromptLeadingAlignment({ promptLeading: emittedBytes, prefixBytes, prefixPath: r.prefixPath });
        emittedByScope.set(r.scope, {
          contentHash: sha256Hex(emittedBytes),
          inlineAligned: verdict.aligned && verdict.mode === "inline",
        });
      }
    }
  }
  const verdict = evaluateDispatchPromptLayout(records, prefixBytesByPath, emittedByScope);
  return {
    verified: verdict.verified,
    headSha,
    recordCount: records.length,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
    ...(verdict.misaligned ? { misaligned: verdict.misaligned } : {}),
  };
}

export async function main(argv = process.argv.slice(2), { tmpRoot = path.join(process.cwd(), "tmp") } = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const headShaArg = resolveFlagValue(argv, "--head-sha");
  if (headShaArg === null || headShaArg === "" || !HEAD_SHA_RE.test(headShaArg)) {
    process.stderr.write(`${formatCliError(parseError(`--head-sha is required and must be the FULL 40- or 64-character hex head SHA${headShaArg ? ` (got ${JSON.stringify(headShaArg)})` : ""}.`))}\n`);
    return 2;
  }
  const headSha = headShaArg.toLowerCase();
  const tmpRootArg = resolveFlagValue(argv, "--tmp-root");
  if (tmpRootArg === "") {
    process.stderr.write(`${formatCliError(parseError("Invalid --tmp-root value: must be non-empty."))}\n`);
    return 2;
  }
  const resolvedTmpRoot = tmpRootArg ?? tmpRoot;
  const jqArg = resolveFlagValue(argv, "--jq");
  if (jqArg === "") {
    process.stderr.write(`${formatCliError(parseError("Invalid --jq value: must be non-empty."))}\n`);
    return 2;
  }
  const jq = jqArg === null ? undefined : jqArg;
  const silent = argv.includes("--silent") || argv.includes("-s");

  const verdict = await verifyDispatchPromptLayoutForHead(resolvedTmpRoot, headSha);
  const payload = { ok: true, ...verdict };
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
