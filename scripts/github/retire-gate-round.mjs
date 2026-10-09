#!/usr/bin/env node
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildParseError, isDirectCliRun, formatCliError } from "../_core-helpers.mjs";
import { parsePrNumber } from "../_cli-primitives.mjs";
import { JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { CHECKPOINT_SENTINEL_PREFIX } from "./verify-fresh-review-context.mjs";
import { GATE_NAMES, gateScopePrefix } from "./_gate-names.mjs";
import { buildGateEmitPlanPath, buildGateReviewsDir } from "./write-gate-context.mjs";
import { EXECUTION_IDENTITY_RE, REVIEW_REF_RE, workOrderDigest } from "./_work-order-protocol.mjs";

const USAGE = `Usage: retire-gate-round.mjs --gate <draft_gate|pre_approval_gate> --head-sha <sha> --reason <text> [--findings-dir <dir>] [--tmp-root <dir>]
Retire ONE GATE's review round at one head: move every regular reviewer
sentinel and dispatch-prompt record of that gate keyed by that full head
out of the live namespaces into an audited retirement directory, preserving
the original bytes without parsing JSON, so a FRESH fan-out can run at the
same head after the gate-context bundle was legitimately rebuilt.

This is the sanctioned rebuild-and-retire path (GATE-EXEC-ROUND-RETIREMENT in
skills/docs/gate-review-sub-loop-contract.md), the complement of the
same-head retry: the retry covers an UNCHANGED prefix (hash equality proves
byte identity), retirement covers a REBUILT prefix (the whole round restarts
so every reviewer of the new round agrees on the one new hash).
verify-briefing-prefixes.mjs keeps failing closed on mixed hashes within a
live round — retired sentinels and dispatch records live under a subdirectory
the flat verifier scans never read, so retired bindings cannot poison fresh fan-in.

Required:
  --gate <name>          Which gate's round to retire: draft_gate or
                         pre_approval_gate. Sentinel and dispatch-record scopes
                         are gate-prefixed (draft-gate- / pre-approval-gate-).
                         Each sweep matches gate prefix + full-head suffix
                         independently, leaving the other gate's round untouched.
  --head-sha <sha>       FULL 40- or 64-char head SHA the round was keyed by (the
                         record filename suffix). A short prefix would match
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
                         silently mix into the new round's fan-in.
  --repo <owner/name>    Repo slug for the canonical artifacts-directory check
                         (#1626). When --findings-dir is omitted and
                         --no-findings-artifacts is not set, retirement
                         REFUSES if the canonical per-angle findings directory
                         (tmp/gate-reviews/<slug>/pr-<N>/<gate>-<headSha>/,
                         the path write-gate-context.mjs / consolidate-fanin
                         use) exists — its artifacts would stay LIVE and mix
                         into the next round's fan-in. Required for that check
                         alongside --pr unless --no-findings-artifacts opts out.
  --pr <number>          PR number for the canonical artifacts-directory check
                         (#1626). See --repo.
  --no-findings-artifacts  Explicit opt-out from the canonical artifacts-directory
                         check (#1626): acknowledge that the retired round's
                         per-angle findings artifacts (if any) are left LIVE at
                         this head. Use only when no canonical artifacts dir
                         exists or the operator accepts the live-artifact risk.
  --tmp-root <dir>       Root tmp directory holding sentinels and dispatch records
                         (default: tmp). MUST exist as a directory — a missing
                         root fails closed rather than reading as an empty round.

Output (stdout, JSON):
  { "ok": true, "gate": "...", "headSha": "...", "retired": <n>,
    "sentinels": [...], "dispatchPromptRecords": [...],
    "findingsDirRetired": <bool>, "retirementDir": "...", "noop": <bool> }
  retired remains the SENTINEL count. dispatchPromptRecords lists sorted
  successfully moved basenames, also recorded in retirement.json.
  A gate+head with no sentinels, no matching dispatch records, and no
  --findings-dir to move is a NO-OP (retired: 0, dispatchPromptRecords: [],
  noop: true), not an error.
On error (stderr, JSON): { "ok": false, "error": "...",
  "partiallyRetired"?: [...], "partiallyRetiredDispatchPromptRecords"?: [...],
  "retirementDir"?: "..." } — a move failure reports separate successful
  sentinel and dispatch-record basenames and their retirement directory.
  A partial audit is still attempted; failure to persist an audit remains an
  error, never clean success.
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success (including the no-op)
  1  Argument error, a missing --findings-dir path, or a move failure
     (partial retirement is reported as above)
  2  Invalid --jq filter`.trim();

const HEAD_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
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
    throw parseError("--head-sha must be the FULL 40- or 64-char hex head SHA the sentinels are keyed by (a short prefix would match nothing and read as a vacuous success)");
  }
  const reason = resolveFlagValue(argv, "--reason");
  if (reason === null || reason.trim().length === 0) {
    throw parseError("Missing required argument: --reason <text> — retirement is explicit and audited (GATE-EXEC-ROUND-RETIREMENT)");
  }
  const findingsDir = resolveFlagValue(argv, "--findings-dir");
  if (findingsDir === "") {
    throw parseError("--findings-dir requires a non-empty path");
  }
  const repo = resolveFlagValue(argv, "--repo");
  if (repo === "") {
    throw parseError("--repo requires a non-empty owner/name slug");
  }
  const prRaw = resolveFlagValue(argv, "--pr");
  if (prRaw === "") {
    throw parseError("--pr requires a positive integer");
  }
  let pr = null;
  if (prRaw !== null) {
    // #1645: route through the shared parsePrNumber primitive so the
    // positive-integer rule lives in one place (@dev-loops/core/cli/primitives).
    pr = parsePrNumber(prRaw, parseError);
  }
  const noFindingsArtifacts = argv.includes("--no-findings-artifacts");
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
    repo: repo ?? null,
    pr,
    noFindingsArtifacts,
    tmpRoot: tmpRoot ?? "tmp",
  };
}

async function captureEmittedExecutions(tmpRoot, gate, headSha) {
  const fail = (reason) => { throw new Error(`GATE-EXEC-ROUND-RETIREMENT: incomplete canonical execution inventory: ${reason}`); };
  const list = async (dir, options) => readdir(dir, options).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  const indexRoot = path.join(tmpRoot, "work-order-executions");
  const executions = new Map();
  for (const entry of await list(indexRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith("r") || !entry.name.endsWith(".json")) continue;
    if (!entry.isFile()) fail(`non-regular review execution index ${entry.name}`);
    const index = JSON.parse(await readFile(path.join(indexRoot, entry.name), "utf8"));
    const key = REVIEW_REF_RE.exec(index?.workOrderRef);
    if (key === null) fail(`invalid review reference in ${entry.name}`);
    if (key[3] !== gate || key[4] !== headSha) continue;
    if (!EXECUTION_IDENTITY_RE.test(index.executionIdentity) || entry.name !== `${index.executionIdentity}.json`
        || typeof index.workOrderDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(index.workOrderDigest)
        || !key[5].startsWith(gateScopePrefix(gate))) fail(`invalid binding in ${entry.name}`);
    executions.set(index.executionIdentity, { executionIdentity: index.executionIdentity, workOrderRef: index.workOrderRef, workOrderDigest: index.workOrderDigest });
  }
  const contextRoot = path.join(tmpRoot, "gate-context");
  for (const entry of await list(contextRoot, { recursive: true, withFileTypes: true })) {
    if (entry.name !== `${gate}-${headSha}.emit-plan.json`) continue;
    if (!entry.isFile()) fail(`non-regular keyed emit plan ${entry.name}`);
    const planPath = path.resolve(entry.parentPath, entry.name);
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    if (plan.gate !== gate || plan.headSha !== headSha || !Array.isArray(plan.units) || plan.count !== plan.units.length
        || planPath !== path.resolve(buildGateEmitPlanPath({ repo: plan.repo, pr: plan.pr, gate, headSha, tmpRoot }))) fail(`invalid keyed emit plan ${planPath}`);
    const seen = new Set();
    for (const unit of plan.units) {
      const index = executions.get(unit?.executionIdentity);
      if (index === undefined || seen.has(unit.executionIdentity)
          || unit.workOrderRef !== `review:${plan.repo}#${plan.pr}:${gate}:${headSha}:${unit.scope}`
          || index.workOrderRef !== unit.workOrderRef || index.workOrderDigest !== unit.workOrderDigest
          || unit.workOrder?.role !== "review" || workOrderDigest(unit.workOrder) !== unit.workOrderDigest) fail(`unindexed or invalid plan unit in ${planPath}`);
      seen.add(unit.executionIdentity);
    }
  }
  const captured = [...executions.values()].sort((a, b) => a.executionIdentity.localeCompare(b.executionIdentity));
  return { count: captured.length, executions: captured };
}

export async function retireGateRound({ gate, headSha, reason, findingsDir = null, repo = null, pr = null, noFindingsArtifacts = false, tmpRoot = "tmp" }) {
  // Function-boundary re-validation, same rule as the CLI parser: a direct
  // programmatic caller must not bypass the full-SHA and audited-reason
  // guardrails.
  if (!VALID_GATES.has(gate)) {
    throw new Error(`Unknown gate ${JSON.stringify(gate)} — must be draft_gate or pre_approval_gate`);
  }
  if (typeof headSha !== "string" || !HEAD_SHA_RE.test(headSha)) {
    throw new Error(`headSha must be the FULL 40- or 64-char hex head SHA, got ${JSON.stringify(headSha)}`);
  }
  // Normalize for artifact filename matches: names embed the lowercase
  // rev-parse output, so uppercase input must not silently retire nothing.
  headSha = headSha.trim().toLowerCase();
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new Error("reason must be a non-empty string — retirement is explicit and audited");
  }
  const scopePrefix = gateScopePrefix(gate);
  const namePrefix = `${CHECKPOINT_SENTINEL_PREFIX}${scopePrefix}`;
  const dispatchNamePrefix = `checkpoint-dispatch-prompt-${scopePrefix}`;
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
  // Dispatch-only records must retire even when no sentinel survives. Match
  // names independently; malformed JSON is still evidence to preserve unchanged.
  const dispatchPromptRecords = entries
    .filter((e) => e.isFile() && e.name.startsWith(dispatchNamePrefix) && e.name.endsWith(suffix))
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

  // #1626: when no --findings-dir is named and the caller did not opt out
  // with --no-findings-artifacts, refuse if the canonical per-angle findings
  // directory for this gate+head exists — its artifacts would stay LIVE at
  // this head and pass the consolidate-fanin --head-sha stamp guard into the
  // next round's fan-in. The canonical path is the one write-gate-context.mjs
  // / consolidate-fanin.mjs use (buildGateReviewsDir), so producer and
  // consumer agree. Placed before the no-op return so orphaned artifacts (a
  // dir with no surviving sentinels) are still caught.
  if (!findingsDirPresent && !noFindingsArtifacts) {
    if (!repo || !pr) {
      throw new Error(
        `retiring ${gate} at head ${headSha} without --findings-dir requires --repo and --pr to check the canonical artifacts directory, or --no-findings-artifacts to explicitly opt out (a stale artifact would pass the head-stamp guard into the next round's fan-in)`,
      );
    }
    const canonicalDir = buildGateReviewsDir({ repo, pr, gate, headSha, tmpRoot });
    let canonStats = null;
    try {
      canonStats = await lstat(canonicalDir);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    if (canonStats !== null && canonStats.isDirectory()) {
      throw new Error(
        `canonical findings-artifacts directory ${JSON.stringify(canonicalDir)} exists for ${gate} at head ${headSha} — pass --findings-dir ${JSON.stringify(canonicalDir)} to retire it, or --no-findings-artifacts to explicitly leave it live`,
      );
    }
  }

  if (sentinels.length === 0 && dispatchPromptRecords.length === 0 && !findingsDirPresent) {
    return { ok: true, gate, headSha, retired: 0, sentinels: [], dispatchPromptRecords: [], findingsDirRetired: false, retirementDir: null, noop: true };
  }
  const emittedExecutionInventory = dispatchPromptRecords.length > 0 ? await captureEmittedExecutions(tmpRoot, gate, headSha) : undefined;


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
  const movedDispatchPromptRecords = [];
  let findingsDirRetired = false;
  // `partial` is an explicit flag, never derived from counts alone: a failed
  // findings-dir move after every record moved is still a PARTIAL retirement
  // and must be recorded as one.
  const writeRecord = async (partial) => {
    const record = {
      gate,
      headSha,
      reason,
      retiredAt: new Date().toISOString(),
      sentinels: moved,
      dispatchPromptRecords: movedDispatchPromptRecords,
      emittedExecutionInventory,
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
    for (const name of dispatchPromptRecords) {
      await rename(path.join(tmpRoot, name), path.join(retirementDir, name));
      movedDispatchPromptRecords.push(name);
    }
    if (findingsDirPresent) {
      await rename(findingsDir, path.join(retirementDir, "findings-artifacts"));
      findingsDirRetired = true;
    }
    await writeRecord(false);
    return { ok: true, gate, headSha, retired: moved.length, sentinels: moved, dispatchPromptRecords: movedDispatchPromptRecords, findingsDirRetired, retirementDir, noop: false };
  } catch (err) {
    // Partial retirement: report what already moved and where it lives, and
    // still write the audit record with the partial state — an unaudited
    // half-retired round would be worse than the failure itself.
    await writeRecord(true).catch(() => {});
    const error = new Error(`${err instanceof Error ? err.message : String(err)} — partial retirement: ${moved.length}/${sentinels.length} sentinel(s) and ${movedDispatchPromptRecords.length}/${dispatchPromptRecords.length} dispatch-prompt record(s) already moved to ${retirementDir}`);
    error.partiallyRetired = moved;
    error.partiallyRetiredDispatchPromptRecords = movedDispatchPromptRecords;
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
      ...(Array.isArray(error?.partiallyRetiredDispatchPromptRecords) ? { partiallyRetiredDispatchPromptRecords: error.partiallyRetiredDispatchPromptRecords } : {}),
      ...(typeof error?.retirementDir === "string" ? { retirementDir: error.retirementDir } : {}),
    })}\n`);
    process.exitCode = 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  await main();
}
