#!/usr/bin/env node
import { mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildParseError, isDirectCliRun, formatCliError } from "../_core-helpers.mjs";
import { JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";

const USAGE = `Usage: retire-gate-round.mjs --head-sha <sha> --reason <text> [--findings-dir <dir>] [--tmp-root <dir>]
Retire a gate-review round at one head: move every reviewer sentinel keyed by
that head out of the live sentinel namespace into an audited retirement
directory, so a FRESH fan-out can run at the same head after the gate-context
bundle was legitimately rebuilt (new briefing-prefix bytes -> new hash that no
existing sentinel can ever match).

This is the sanctioned rebuild-and-retire path (GATE-EXEC-ROUND-RETIREMENT in
skills/docs/gate-review-sub-loop-contract.md), the complement of the
same-head retry: the retry covers an UNCHANGED prefix (hash equality proves
byte identity), retirement covers a REBUILT prefix (the whole round restarts
so every reviewer of the new round agrees on the one new hash).
verify-briefing-prefixes.mjs keeps failing closed on mixed hashes within a
live round — retired sentinels live under a subdirectory its flat scan never
reads, so retirement can never mix two prefixes into one consolidation.

Required:
  --head-sha <sha>       FULL 40-char head SHA the round was keyed by (the
                         sentinel filename suffix). A short prefix would match
                         nothing and read as a vacuous success — rejected.
  --reason <text>        Why the round is being retired (recorded verbatim in
                         the audit record; retirement is explicit and audited,
                         never a side effect).
Optional:
  --findings-dir <dir>   The round's per-angle findings artifacts directory.
                         When given, it is moved into the retirement directory
                         (an explicit discard that stays recoverable). Pass it
                         whenever artifacts were written for the retired round:
                         at the SAME head, a stale artifact would pass the
                         consolidate-fanin --head-sha stamp guard and silently
                         mix into the new round's fan-in.
  --tmp-root <dir>       Root tmp directory holding the sentinels (default: tmp).

Output (stdout, JSON):
  { "ok": true, "headSha": "...", "retired": <n>, "sentinels": [...],
    "findingsDirRetired": <bool>, "retirementDir": "...", "noop": <bool> }
  A head with no sentinels (and no --findings-dir to move) is a NO-OP
  (retired: 0, noop: true), not an error.
On error (stderr, JSON): { "ok": false, "error": "...", "usage"?: "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success (including the no-op)
  1  Argument error or a move failure (partial retirement is reported)
  2  Invalid --jq filter`.trim();

const HEAD_SHA_RE = /^[0-9a-f]{40}$/i;
const SENTINEL_PREFIX = "checkpoint-context-sentinel-";
const parseError = buildParseError(USAGE);

function resolveFlagValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  const val = argv[idx + 1];
  if (val === undefined || val === "" || (val.length > 0 && val[0] === "-")) {
    return "";
  }
  return val;
}

export function parseRetireGateRoundArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { help: true };
  }
  const headShaRaw = resolveFlagValue(argv, "--head-sha");
  if (headShaRaw === null || headShaRaw === "") {
    throw parseError("Missing required argument: --head-sha <sha>");
  }
  const headSha = headShaRaw.trim().toLowerCase();
  if (!HEAD_SHA_RE.test(headSha)) {
    throw parseError("--head-sha must be the FULL 40-char hex head SHA the sentinels are keyed by (a short prefix would match nothing and read as a vacuous success)");
  }
  const reason = resolveFlagValue(argv, "--reason");
  if (reason === null || reason.trim().length === 0) {
    throw parseError("Missing required argument: --reason <text> — retirement is explicit and audited");
  }
  const findingsDir = resolveFlagValue(argv, "--findings-dir");
  if (findingsDir === "") {
    throw parseError("--findings-dir requires a non-empty path");
  }
  const tmpRoot = resolveFlagValue(argv, "--tmp-root");
  if (tmpRoot === "") {
    throw parseError("--tmp-root requires a non-empty path");
  }
  return {
    help: false,
    headSha,
    reason: reason.trim(),
    findingsDir: findingsDir ?? null,
    tmpRoot: tmpRoot ?? "tmp",
  };
}

export async function retireGateRound({ headSha, reason, findingsDir = null, tmpRoot = "tmp" }) {
  const suffix = `-${headSha}.json`;
  let entries = [];
  try {
    entries = await readdir(tmpRoot, { withFileTypes: true });
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const sentinels = entries
    .filter((e) => e.isFile() && e.name.startsWith(SENTINEL_PREFIX) && e.name.endsWith(suffix))
    .map((e) => e.name)
    .sort();

  let findingsDirPresent = false;
  if (findingsDir !== null) {
    try {
      findingsDirPresent = (await stat(findingsDir)).isDirectory();
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  if (sentinels.length === 0 && !findingsDirPresent) {
    return { ok: true, headSha, retired: 0, sentinels: [], findingsDirRetired: false, retirementDir: null, noop: true };
  }

  // One retirement directory per invocation, sequence-numbered so repeated
  // retirements at the same head never collide and every retirement stays
  // individually auditable. Lives under a SUBdirectory of tmp/, which the
  // live-sentinel scans (exact-path stat in verify-fresh-review-context.mjs,
  // flat readdir in verify-briefing-prefixes.mjs) never read by construction.
  const retiredRoot = path.join(tmpRoot, "retired-gate-rounds", headSha);
  await mkdir(retiredRoot, { recursive: true });
  const existing = await readdir(retiredRoot);
  const seq = existing.filter((name) => /^round-\d+$/.test(name)).length + 1;
  const retirementDir = path.join(retiredRoot, `round-${seq}`);
  await mkdir(retirementDir, { recursive: true });

  for (const name of sentinels) {
    await rename(path.join(tmpRoot, name), path.join(retirementDir, name));
  }
  let findingsDirRetired = false;
  if (findingsDirPresent) {
    await rename(findingsDir, path.join(retirementDir, "findings-artifacts"));
    findingsDirRetired = true;
  }
  const record = {
    headSha,
    reason,
    retiredAt: new Date().toISOString(),
    sentinels,
    findingsDir: findingsDirRetired ? findingsDir : null,
  };
  await writeFile(path.join(retirementDir, "retirement.json"), JSON.stringify(record, null, 2) + "\n", "utf8");
  return { ok: true, headSha, retired: sentinels.length, sentinels, findingsDirRetired, retirementDir, noop: false };
}

async function main() {
  let options;
  try {
    options = parseRetireGateRoundArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const jqIdx = process.argv.indexOf("--jq");
  const jq = jqIdx !== -1 ? process.argv[jqIdx + 1] : undefined;
  const silent = process.argv.includes("--silent") || process.argv.includes("-s");
  try {
    const result = await retireGateRound(options);
    process.exitCode = emitResult(result, { jq, silent });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  await main();
}
