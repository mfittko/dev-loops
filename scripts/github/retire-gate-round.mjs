#!/usr/bin/env node
import { lstat, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildParseError, isDirectCliRun, formatCliError } from "../_core-helpers.mjs";
import { JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { CHECKPOINT_SENTINEL_PREFIX } from "./verify-fresh-review-context.mjs";
import { GATE_NAMES, gateScopePrefix } from "./_gate-names.mjs";

const USAGE = `Usage: retire-gate-round.mjs --gate <draft_gate|pre_approval_gate> --head-sha <sha> --reason <text> [--findings-dir <dir>] [--tmp-root <dir>]
Retire ONE GATE's review round at one head: move every reviewer sentinel of
that gate keyed by that head out of the live sentinel namespace into an
audited retirement directory, so a FRESH fan-out can run at the same head
after the gate-context bundle was legitimately rebuilt (new briefing-prefix
bytes -> new hash that no existing sentinel can ever match).

This is the sanctioned rebuild-and-retire path (GATE-EXEC-ROUND-RETIREMENT in
skills/docs/gate-review-sub-loop-contract.md), the complement of the
same-head retry: the retry covers an UNCHANGED prefix (hash equality proves
byte identity), retirement covers a REBUILT prefix (the whole round restarts
so every reviewer of the new round agrees on the one new hash).
verify-briefing-prefixes.mjs keeps failing closed on mixed hashes within a
live round — retired sentinels live under a subdirectory its flat scan never
reads, so retirement can never mix two prefixes into one consolidation.

Required:
  --gate <name>          Which gate's round to retire: draft_gate or
                         pre_approval_gate. Sentinel scopes are gate-prefixed
                         (draft-gate-<angle> / pre-approval-gate-<angle>), so
                         this bounds the sweep to ONE gate — the other gate's
                         live round at the same head is never touched.
  --head-sha <sha>       FULL 40-char head SHA the round was keyed by (the
                         sentinel filename suffix). A short prefix would match
                         nothing and read as a vacuous success — rejected.
  --reason <text>        Why the round is being retired (recorded verbatim in
                         the audit record; retirement is explicit and audited,
                         never a side effect).
Optional:
  --findings-dir <dir>   The round's per-angle findings artifacts directory.
                         When given it MUST exist as a real directory (no
                         symlink) whose basename names the retired head SHA —
                         both checks fail closed rather than silently leaving
                         artifacts live or relocating an unrelated directory.
                         It is moved into the retirement directory, an
                         explicit discard recoverable for AUDIT only. Pass it
                         whenever artifacts were written for the retired
                         round: at the SAME head, a stale artifact would pass
                         the consolidate-fanin --head-sha stamp guard and
                         silently mix into the new round's fan-in. Omitting
                         it while sentinels are retired emits a warning for
                         the same reason.
  --tmp-root <dir>       Root tmp directory holding the sentinels (default:
                         tmp). MUST exist as a directory — a missing root
                         fails closed rather than reading as an empty round.

Output (stdout, JSON):
  { "ok": true, "gate": "...", "headSha": "...", "retired": <n>,
    "sentinels": [...], "findingsDirRetired": <bool>,
    "retirementDir": "...", "noop": <bool>, "warning"?: "..." }
  A gate+head with no sentinels (and no --findings-dir to move) is a NO-OP
  (retired: 0, noop: true), not an error.
On error (stderr, JSON): { "ok": false, "error": "...",
  "partiallyRetired"?: [...], "retirementDir"?: "..." } — a move failure
  mid-retirement reports every sentinel already moved and the retirement
  directory holding them, and the audit record is still written with the
  partial state.
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success (including the no-op)
  1  Argument error, a missing --findings-dir path, or a move failure
     (partial retirement is reported as above)
  2  Invalid --jq filter`.trim();

const HEAD_SHA_RE = /^[0-9a-f]{40}$/i;
const VALID_GATES = new Set(GATE_NAMES);
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
  const gate = resolveFlagValue(argv, "--gate");
  if (gate === null || gate === "" || !VALID_GATES.has(gate)) {
    throw parseError("Missing or invalid --gate — must be draft_gate or pre_approval_gate (retirement is per gate-round; the other gate's live sentinels at the same head must never be swept)");
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
    gate,
    headSha,
    reason: reason.trim(),
    findingsDir: findingsDir ?? null,
    tmpRoot: tmpRoot ?? "tmp",
  };
}

export async function retireGateRound({ gate, headSha, reason, findingsDir = null, tmpRoot = "tmp" }) {
  // Function-boundary re-validation, same rule as the CLI parser: a direct
  // programmatic caller must not bypass the full-SHA and audited-reason
  // guardrails.
  if (!VALID_GATES.has(gate)) {
    throw new Error(`Unknown gate ${JSON.stringify(gate)} — must be draft_gate or pre_approval_gate`);
  }
  if (typeof headSha !== "string" || !HEAD_SHA_RE.test(headSha)) {
    throw new Error(`headSha must be the FULL 40-char hex head SHA, got ${JSON.stringify(headSha)}`);
  }
  // Normalize for the sentinel filename match: sentinel names embed the
  // lowercase rev-parse output, so an uppercase programmatic value would
  // silently retire nothing.
  headSha = headSha.trim().toLowerCase();
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new Error("reason must be a non-empty string — retirement is explicit and audited");
  }
  const namePrefix = `${CHECKPOINT_SENTINEL_PREFIX}${gateScopePrefix(gate)}`;
  const suffix = `-${headSha}.json`;
  let entries = [];
  try {
    entries = await readdir(tmpRoot, { withFileTypes: true });
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    // A missing tmp root means the caller pointed retirement at the wrong
    // place: nothing sentinel-shaped could ever live there, so "retired: 0"
    // would be the vacuous success the full-SHA guard exists to prevent.
    throw new Error(`tmp root ${JSON.stringify(tmpRoot)} is not an existing directory — refusing a retirement that would vacuously succeed`);
  }
  const sentinels = entries
    .filter((e) => e.isFile() && e.name.startsWith(namePrefix) && e.name.endsWith(suffix))
    .map((e) => e.name)
    .sort();

  let findingsDirPresent = false;
  if (findingsDir !== null) {
    let stats = null;
    try {
      stats = await lstat(findingsDir);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    // Fail closed on a typo: an explicitly named findings dir that does not
    // exist as a directory would otherwise read as "nothing to retire" while
    // the real artifacts stay live and mix into the next round's fan-in.
    // lstat, not stat: a symlink must not smuggle an unrelated directory
    // through the guard (rename would move the link target's namespace entry,
    // not what the link points at — the guard and the move must agree).
    if (stats === null || !stats.isDirectory()) {
      throw new Error(`--findings-dir ${JSON.stringify(findingsDir)} is not an existing directory (symlinks are rejected) — refusing a retirement that would silently leave the round's artifacts live`);
    }
    // The findings dir must be THIS round's: sanctioned round-artifact
    // directories are keyed by the full head SHA in their basename. Without
    // this, any existing directory could be silently relocated under an
    // ok:true report.
    if (!path.basename(findingsDir).includes(headSha)) {
      throw new Error(`--findings-dir ${JSON.stringify(findingsDir)} does not name head ${headSha} in its basename — refusing to retire a directory that is not this round's artifacts`);
    }
    findingsDirPresent = true;
  }

  if (sentinels.length === 0 && !findingsDirPresent) {
    return { ok: true, gate, headSha, retired: 0, sentinels: [], findingsDirRetired: false, retirementDir: null, noop: true };
  }

  // One retirement directory per invocation. The sequence number is MAX-based
  // (never count-based: a deleted round must not make the next retirement
  // reuse its number) and the mkdir is EXCLUSIVE with a bump-and-retry, so a
  // concurrent invocation can never clobber another retirement's audit record.
  const retiredRoot = path.join(tmpRoot, "retired-gate-rounds", headSha);
  await mkdir(retiredRoot, { recursive: true });
  const existing = await readdir(retiredRoot);
  const numbers = existing.map((name) => /^round-(\d+)$/.exec(name)).filter(Boolean).map((m) => Number(m[1]));
  let seq = (numbers.length > 0 ? Math.max(...numbers) : 0) + 1;
  let retirementDir;
  for (;;) {
    retirementDir = path.join(retiredRoot, `round-${seq}`);
    try {
      await mkdir(retirementDir);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      seq += 1;
    }
  }

  const moved = [];
  let findingsDirRetired = false;
  // `partial` is an explicit flag, never derived from counts alone: a failed
  // findings-dir move after every sentinel moved is still a PARTIAL
  // retirement and must be recorded as one.
  const writeRecord = async (partial) => {
    const record = {
      gate,
      headSha,
      reason,
      retiredAt: new Date().toISOString(),
      sentinels: moved,
      findingsDir: findingsDirPresent ? findingsDir : null,
      findingsDirRetired,
      partial,
    };
    await writeFile(path.join(retirementDir, "retirement.json"), JSON.stringify(record, null, 2) + "\n", "utf8");
  };
  try {
    for (const name of sentinels) {
      await rename(path.join(tmpRoot, name), path.join(retirementDir, name));
      moved.push(name);
    }
    if (findingsDirPresent) {
      await rename(findingsDir, path.join(retirementDir, "findings-artifacts"));
      findingsDirRetired = true;
    }
    await writeRecord(false);
    // An omitted --findings-dir has the same consequence as a mistyped one
    // when the round DID write artifacts: they stay live at this head. The
    // omission can be legitimate (no artifacts written), so it warns instead
    // of failing closed.
    const warning = findingsDirPresent
      ? null
      : "no --findings-dir was given — if the retired round wrote findings artifacts they remain LIVE at this head and would pass the head-stamp guard into the next round's fan-in";
    return { ok: true, gate, headSha, retired: moved.length, sentinels: moved, findingsDirRetired, retirementDir, noop: false, ...(warning ? { warning } : {}) };
  } catch (err) {
    // Partial retirement: report what already moved and where it lives, and
    // still write the audit record with the partial state — an unaudited
    // half-retired round would be worse than the failure itself.
    await writeRecord(true).catch(() => {});
    const error = new Error(`${err instanceof Error ? err.message : String(err)} — partial retirement: ${moved.length}/${sentinels.length} sentinel(s) already moved to ${retirementDir}`);
    error.partiallyRetired = moved;
    error.retirementDir = retirementDir;
    throw error;
  }
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
  // Same missing/flag-like handling as every other flag in this file.
  const jqValue = resolveFlagValue(process.argv, "--jq");
  if (jqValue === "") {
    process.stderr.write(`${JSON.stringify({ ok: false, error: "--jq requires a filter argument" })}\n`);
    process.exitCode = 2;
    return;
  }
  const jq = jqValue ?? undefined;
  const silent = process.argv.includes("--silent") || process.argv.includes("-s");
  try {
    const result = await retireGateRound(options);
    process.exitCode = emitResult(result, { jq, silent });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(Array.isArray(error?.partiallyRetired) ? { partiallyRetired: error.partiallyRetired } : {}),
      ...(typeof error?.retirementDir === "string" ? { retirementDir: error.retirementDir } : {}),
    })}\n`);
    process.exitCode = 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  await main();
}
