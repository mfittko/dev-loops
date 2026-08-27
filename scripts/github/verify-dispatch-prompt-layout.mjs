#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { verifyPromptLeadingAlignment } from "@dev-loops/core/loop/review-dispatch-plan";
import { validateBriefingPrefixPath } from "./record-dispatch-prompt-layout.mjs";

const USAGE = `Usage: verify-dispatch-prompt-layout.mjs --head-sha <sha> [--tmp-root <path>] [--help]
Fan-in enforcement of the reviewer-PROMPT layout half of GATE-EXEC-BRIEFING-PREFIX
(skills/docs/gate-review-sub-loop-contract.md), completing #1468: verify-briefing-
prefixes.mjs proves the recorded prefix HASH is byte-identical across a round's
reviewer sentinels, but proves nothing about whether any reviewer's ACTUAL prompt
led with those bytes. This checker reads the leading-bytes dispatch records
record-dispatch-prompt-layout.mjs writes at fan-out and fails closed (exit 1) when
any recorded prompt does NOT lead with the round's byte-identical invariant prefix
(inline mode) or its byte-identical pointer line (pointer-seeding mode) — an
angle-first prompt (dynamic per-unit prose ahead of the prefix/pointer) fails this
mechanically instead of only being documented.

Ground truth for the comparison is ALWAYS re-discovered on disk here (never
trusted from a record's own stored "prefixPath" directory): each record's
basename names a (gate, headSha) pair, and this checker independently locates
that gate's real \`<tmp-root>/gate-context/**/<gate>-<headSha>.briefing-prefix.txt\`
record (the same file write-gate-context.mjs/verify-briefing-prefixes.mjs treat
as authoritative) to read its bytes.

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
     newly blocks), OR every recorded prompt is aligned
  1  Fail closed: at least one recorded prompt does not lead with the round's
     byte-identical invariant prefix or pointer line, or a record's own
     "prefixPath" basename no longer names a real on-disk gate-context record
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
 * @returns {Promise<Array<{ scope: string, prefixPath: string|null, leading: string|null }>>}
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
      results.push({ scope, prefixPath, leading });
    } catch {
      results.push({ scope, prefixPath: null, leading: null });
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
 * Pure comparison over already-read records + already-read prefix bytes.
 * Exported for direct unit testing without touching the filesystem.
 *
 * @param {Array<{ scope: string, prefixPath: string|null, leading: string|null }>} records
 * @param {Map<string, string>} prefixBytesByPath — record's raw "prefixPath" string -> the RE-DISCOVERED real prefix bytes for its (gate, headSha)
 * @returns {{ verified: boolean, reason?: string, misaligned?: Array<{scope:string, reason:string}> }}
 */
export function evaluateDispatchPromptLayout(records, prefixBytesByPath) {
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
    const verdict = verifyPromptLeadingAlignment({ promptLeading: r.leading, prefixBytes, prefixPath: r.prefixPath });
    if (!verdict.aligned) {
      misaligned.push({ scope: r.scope, reason: verdict.reason });
    }
  }
  if (misaligned.length > 0) {
    return {
      verified: false,
      reason: `${misaligned.length} of ${records.length} dispatched reviewer prompt(s) for this round do not lead with the round's byte-identical invariant prefix or pointer line (GATE-EXEC-BRIEFING-PREFIX) — an angle-first prompt defeats cache alignment.`,
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
  for (const r of records) {
    if (r.prefixPath === null || prefixBytesByPath.has(r.prefixPath)) continue;
    const check = validateBriefingPrefixPath(r.prefixPath, headSha);
    if (!check.ok) continue; // left unset -> evaluateDispatchPromptLayout fails closed on it
    const bytes = await findGateBriefingPrefixBytes(tmpRoot, check.gate, headSha);
    if (bytes !== null) prefixBytesByPath.set(r.prefixPath, bytes);
  }
  const verdict = evaluateDispatchPromptLayout(records, prefixBytesByPath);
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
