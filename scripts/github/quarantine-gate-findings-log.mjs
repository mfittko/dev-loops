#!/usr/bin/env node
/**
 * quarantine-gate-findings-log.mjs — the sanctioned exit from a prior-head
 * gate findings-log that fails carry-forward integrity (GATE-EXEC-FINDINGS-LOG-QUARANTINE).
 *
 * Re-runs the exact integrity check resolve-angle-carry-forward.mjs applies
 * (buildCarryForwardPlan plus its path/recorded-head identity check). On an
 * integrity FAILURE it moves the log and its keyed fan-in ledger into an audit
 * directory (never deletes) and records the reason and the failure message, so
 * the next round at a later head sees no prior log. On a log that PASSES
 * integrity it refuses (quarantine_refused_log_valid) and moves nothing.
 */
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { parsePrNumber, requireTokenValue } from "../_cli-primitives.mjs";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { emitResult } from "../lib/jq-output.mjs";
import { assertTmpRootOutsideLinkedWorktree, resolveGateArtifactTmpRoot } from "../loop/_repo-root-resolver.mjs";
import { buildGateFaninLedgerPath } from "./_gate-artifact-paths.mjs";
import { normalizeFullHeadSha } from "../lib/head-sha.mjs";
import { normalizeGate } from "./_gate-names.mjs";
import { buildCarryForwardPlan } from "./resolve-angle-carry-forward.mjs";
import { OUT_OF_BAND_WRITE, readSealed } from "./_gate-artifact-seal.mjs";
import { buildLogPath } from "./write-gate-findings-log.mjs";

const USAGE = `Usage: quarantine-gate-findings-log.mjs --repo <owner/name> --pr <N> --gate <draft_gate|pre_approval_gate> --prev-head <full-sha> [--tmp-root <dir>] [--context-tmp-root <dir>]
Move a prior-head gate findings-log that FAILS carry-forward integrity, and its
keyed fan-in ledger, into tmp/quarantined-gate-findings/ (never deleted), with
quarantine.json recording the reason and the exact integrity failure. The next
round at a later head then has no prior log: every angle runs fresh.
--context-tmp-root locates the keyed fan-in ledger (default: tmp under the cwd, like the writer).
A log that passes integrity is refused (code quarantine_refused_log_valid) and
nothing moves. See GATE-EXEC-FINDINGS-LOG-QUARANTINE in
skills/docs/gate-review-sub-loop-contract.md.
Exit codes: 0 quarantined, 1 refused or error`;

function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

function typedError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function parseQuarantineArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      gate: { type: "string" },
      "prev-head": { type: "string" },
      "tmp-root": { type: "string" },
      "context-tmp-root": { type: "string" },
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {};
  for (const token of tokens) {
    if (token.kind === "positional") throw parseError(`Unknown argument: ${token.value}`);
    if (token.kind !== "option") continue;
    if (token.name === "help") return { help: true };
    if (token.name === "repo") options.repo = requireTokenValue(token, parseError).trim();
    else if (token.name === "pr") options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError);
    else if (token.name === "gate") {
      options.gate = normalizeGate(requireTokenValue(token, parseError));
      if (!options.gate) throw parseError("--gate must be draft_gate or pre_approval_gate");
    } else if (token.name === "prev-head") {
      options.prevHead = normalizeFullHeadSha(requireTokenValue(token, parseError));
      if (!options.prevHead) throw parseError("--prev-head must be the FULL head commit SHA (40 or 64 hex chars)");
    } else if (token.name === "tmp-root" || token.name === "context-tmp-root") {
      const value = requireTokenValue(token, parseError).trim();
      if (value === "") throw parseError(`--${token.name} must be non-empty`);
      options[token.name === "tmp-root" ? "tmpRoot" : "contextTmpRoot"] = value;
    } else throw parseError(`Unknown argument: ${token.rawName}`);
  }
  for (const key of ["repo", "pr", "gate", "prevHead"]) {
    if (options[key] === undefined) throw parseError(`Missing required argument: ${key}`);
  }
  return options;
}

/** Returns the integrity-failure message of a prior log, or null when it passes. */
function integrityFailure(log, prevHead) {
  const recordedHead = typeof log?.headSha === "string" ? log.headSha.trim().toLowerCase() : null;
  if (recordedHead !== prevHead) {
    return `prior gate findings-log records headSha ${JSON.stringify(log?.headSha ?? null)}, which is not --prev-head ${prevHead}`;
  }
  try {
    // Same check as the resolver; an empty delta is enough because integrity
    // errors are raised before any delta-dependent decision.
    buildCarryForwardPlan({ log, changedFiles: [] });
  } catch (error) {
    // The one eligibility refusal (verdict not clean/findings_present) is a
    // readable, well-formed log: the resolver handles it with a fallback plan.
    if (error?.carryForwardRefusal === true) return null;
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

async function exists(file) {
  return stat(file).then(() => true, (err) => {
    if (err?.code === "ENOENT") return false;
    throw err;
  });
}

export async function quarantineGateFindingsLog({ repo, pr, gate, prevHead, tmpRoot, contextTmpRoot, repoRoot = process.cwd() }) {
  if (tmpRoot) assertTmpRootOutsideLinkedWorktree(path.resolve(repoRoot, tmpRoot), repoRoot);
  const root = tmpRoot ?? resolveGateArtifactTmpRoot(repoRoot);
  const logPath = path.resolve(repoRoot, buildLogPath({ repo, pr, gate, headSha: prevHead, tmpRoot: root }));
  let log;
  let failure;
  try {
    log = JSON.parse(await readSealed(logPath));
    failure = integrityFailure(log, prevHead);
  } catch (err) {
    if (err?.code === "ENOENT") throw typedError("quarantine_log_not_found", `no prior gate findings-log at ${logPath}`);
    if (err?.code === OUT_OF_BAND_WRITE) failure = err.message;
    else if (err instanceof SyntaxError) failure = `prior gate findings-log is not valid JSON: ${err.message}`;
    else throw err;
  }
  if (failure === null) {
    throw typedError("quarantine_refused_log_valid", `GATE-EXEC-FINDINGS-LOG-QUARANTINE: prior gate findings-log at ${logPath} passes integrity; quarantine refuses to discard valid evidence`);
  }
  const ledgerPath = path.resolve(repoRoot, buildGateFaninLedgerPath({ repo, pr, gate, headSha: prevHead, tmpRoot: contextTmpRoot || "tmp" }));
  const auditDir = path.resolve(
    repoRoot, root, "quarantined-gate-findings", repo.replace("/", "-"), `pr-${pr}`,
    `${gate}-${prevHead}-${new Date().toISOString().replace(/[^0-9]/g, "")}`,
  );
  // Reserve the audit dir exclusively: a concurrent invocation in the same millisecond gets EEXIST
  // and cannot overwrite this run's record.
  await mkdir(path.dirname(auditDir), { recursive: true });
  try {
    await mkdir(auditDir);
  } catch (err) {
    if (err?.code === "EEXIST") throw typedError("quarantine_concurrent_run", `GATE-EXEC-FINDINGS-LOG-QUARANTINE: audit dir ${auditDir} already exists (concurrent quarantine); nothing was moved`);
    throw err;
  }
  const planned = [];
  const ledgerAbsent = !(await exists(ledgerPath));
  for (const file of [logPath, ledgerPath]) {
    for (const f of [file, `${file}.seal`]) {
      if (await exists(f)) planned.push({ from: f, to: path.join(auditDir, path.basename(f)) });
    }
  }
  // Record intent BEFORE any rename: the emitter's quarantine cutoff reads quarantinedAt,
  // and a crash mid-move leaves a record. A re-run does not resume it: once the log has moved, the
  // re-run finds no log. A partial record names the files left in the audit dir in stillInAuditDir
  // for manual review.
  const recordPath = path.join(auditDir, "quarantine.json");
  const record = {
    repo, pr, gate, prevHead, reason: "findings_log_integrity_failure", integrityFailure: failure,
    quarantinedAt: new Date().toISOString(), ledgerAbsent, ledgerPath, plannedMoves: planned.map((m) => path.basename(m.from)), status: "pending",
  };
  // Write a temp sibling then rename over the record: an interrupted update keeps the readable prior record.
  const save = async () => {
    const tmpPath = `${recordPath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(tmpPath, recordPath);
  };
  await save();
  const done = [];
  try {
    for (const m of planned) {
      await rename(m.from, m.to);
      done.push(m);
    }
  } catch (err) {
    const stuck = [];
    for (const m of done.reverse()) {
      try { await rename(m.to, m.from); } catch { stuck.push(path.basename(m.to)); }
    }
    record.status = stuck.length ? "partial" : "rolled_back";
    record.stillInAuditDir = stuck;
    record.error = err instanceof Error ? err.message : String(err);
    await save();
    throw err;
  }
  record.status = "complete";
  record.moved = done.map((m) => path.basename(m.to));
  await save();
  return { ok: true, ...record, auditDir };
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseQuarantineArgs(argv);
  } catch (error) {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  try {
    process.exitCode = emitResult(await quarantineGateFindingsLog(options), {});
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  await main();
}
