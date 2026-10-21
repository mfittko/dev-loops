/**
 * Read-only Codex execution-terminal evidence adapter.
 *
 * Reconciles ONE owned native Codex execution against the single already-resolved
 * owning rollout journal and returns a typed disposition. It never scans other
 * sessions, never searches globally, never follows a caller-supplied path in
 * production mode, and never converts a tool-session identifier into an OS process
 * identifier. This module imports no process, child-process, spawn or signal API.
 *
 * Typed statuses:
 *   - `completed`   exactly one terminal CommandExecution record binds to the
 *                   supplied owner thread, execution id, repository and cwd.
 *   - `unknown`     no result, wrong owner/thread, wrong execution id, wrong cwd or
 *                   repository, malformed record, schema drift, conflicting records.
 *   - `unsupported` the runtime cannot use a supported session/result API and cannot
 *                   read the native journal here.
 *
 * Supported schema disclosure (derived from the real journal named in issue 2886's
 * Evidence locator, `rollout-2026-10-20T13-54-33-01a15929-c860-7690-86d8-50f51506a786.jsonl`,
 * terminal record `ordinal: 185` for tool session `12938`). These are the ONLY JSON
 * pointer paths this adapter reads. A terminal record missing a required path is
 * schema drift and yields `unknown`; unread extra paths are ignored.
 *
 * | Field                         | JSON pointer                     | Required | Notes |
 * | ----------------------------- | -------------------------------- | -------- | ----- |
 * | event discriminator           | `/type`                          | yes      | `event_msg` |
 * | terminal item discriminator   | `/payload/type`                  | yes      | `item_completed` |
 * | execution item type           | `/payload/item/type`             | yes      | `CommandExecution` |
 * | owning thread id              | `/payload/thread_id`             | yes      | equals `--owner-thread-id` |
 * | tool session / execution id   | `/payload/item/process_id`       | yes      | opaque string, e.g. `"12938"` |
 * | native execution id           | `/payload/item/id`               | yes      | alternate execution-id binding, e.g. `exec-...` |
 * | terminal timestamp            | `/timestamp`                     | yes      | ISO-8601 |
 * | terminal status               | `/payload/item/status`           | yes      | e.g. `failed` |
 * | exit code                     | `/payload/item/exit_code`        | yes      | integer |
 * | command                       | `/payload/item/command`          | yes      | array of strings |
 * | working directory             | `/payload/item/cwd`              | yes      | `file://` URI |
 * | retained output               | `/payload/item/aggregated_output`| yes      | recorded text |
 * | completion epoch (corroborate)| `/payload/completed_at_ms`       | no       | integer ms |
 * | start epoch (corroborate)     | `/payload/started_at_ms`         | no       | integer ms |
 * | journal header owner          | `/payload/id on /type = session_meta` | yes | equals `--owner-thread-id` |
 */

import fsDefault from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  NATIVE_CODEX_THREAD_ID_PATTERN,
  findNativeCodexSessionJournal,
} from "./run-context.mjs";

/** Upper bound on the journal bytes this adapter will read. */
export const CODEX_JOURNAL_MAX_BYTES = 64 * 1024 * 1024;

/** Structured disclosure of the exact key paths read; mirrored in `skills/docs/main-agent-contract.md`. */
export const CODEX_EXECUTION_EVIDENCE_SCHEMA = Object.freeze([
  Object.freeze({ field: "event discriminator", pointer: "/type", required: true }),
  Object.freeze({ field: "terminal item discriminator", pointer: "/payload/type", required: true }),
  Object.freeze({ field: "execution item type", pointer: "/payload/item/type", required: true }),
  Object.freeze({ field: "owning thread id", pointer: "/payload/thread_id", required: true }),
  Object.freeze({ field: "tool session / execution id", pointer: "/payload/item/process_id", required: true }),
  Object.freeze({ field: "native execution id", pointer: "/payload/item/id", required: true }),
  Object.freeze({ field: "terminal timestamp", pointer: "/timestamp", required: true }),
  Object.freeze({ field: "terminal status", pointer: "/payload/item/status", required: true }),
  Object.freeze({ field: "exit code", pointer: "/payload/item/exit_code", required: true }),
  Object.freeze({ field: "command", pointer: "/payload/item/command", required: true }),
  Object.freeze({ field: "working directory", pointer: "/payload/item/cwd", required: true }),
  Object.freeze({ field: "retained output", pointer: "/payload/item/aggregated_output", required: true }),
  Object.freeze({ field: "completion epoch (corroboration)", pointer: "/payload/completed_at_ms", required: false }),
  Object.freeze({ field: "start epoch (corroboration)", pointer: "/payload/started_at_ms", required: false }),
  Object.freeze({ field: "journal header owner", pointer: "/payload/id on /type = session_meta", required: true }),
]);

/** Non-cleanup-blocking disposition for a verified terminal result. */
const COMPLETED_CLEANUP = Object.freeze({ blocker: false, processProbeAllowed: false });
/** Unknown/unsupported disposition: never a cleanup authorization and never a probe authorization. */
const UNKNOWN_CLEANUP = Object.freeze({ blocker: "unknown", processProbeAllowed: false });

/**
 * Pure cleanup disposition for a reconciliation status.
 *
 * `completed` is the ONLY status that clears the cleanup blocker. Reconciliation
 * never authorizes a process probe, in any status.
 *
 * @param {"completed"|"unknown"|"unsupported"} status
 * @param {{ processProbe?: Function }} [options] - Optional injected spy; never called.
 * @returns {{ blocker: false|"unknown", processProbeAllowed: false }}
 */
export function cleanupDisposition(status, options = {}) {
  // The optional processProbe spy is accepted only so tests can prove no path calls it.
  void options?.processProbe;
  return status === "completed" ? { ...COMPLETED_CLEANUP } : { ...UNKNOWN_CLEANUP };
}

function isNonBlankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string");
}

function canonicalPath(target, fs) {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function decodeJournalCwd(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (!raw.startsWith("file://")) return raw;
  try {
    return fileURLToPath(new URL(raw));
  } catch {
    return null;
  }
}

/**
 * Validate that a parsed journal header names the supplied owner thread.
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateCodexJournalOwner(header, ownerThreadId) {
  if (header?.type !== "session_meta" || header?.payload?.id !== ownerThreadId) {
    return { ok: false, reason: "owner_journal_mismatch" };
  }
  return { ok: true };
}

function readOwnerJournal({ ownerThreadId, journalPath, env, fs }) {
  let resolvedPath;
  if (isNonBlankString(journalPath)) {
    resolvedPath = path.resolve(journalPath);
  } else {
    const discovery = findNativeCodexSessionJournal({ threadId: ownerThreadId, env, fs });
    if (discovery.status !== "found") return { ok: false, reason: discovery.reason };
    resolvedPath = discovery.path;
  }
  let raw;
  try {
    if (!fs.statSync(resolvedPath).isFile()) return { ok: false, reason: "owner_journal_not_a_file" };
    if (fs.statSync(resolvedPath).size > CODEX_JOURNAL_MAX_BYTES) return { ok: false, reason: "owner_journal_exceeds_byte_bound" };
    raw = fs.readFileSync(resolvedPath, "utf8");
  } catch (error) {
    return { ok: false, reason: `owner_journal_unreadable: ${error?.code ?? "unknown"}` };
  }
  const firstLine = raw.split("\n", 1)[0];
  let header;
  try {
    header = JSON.parse(firstLine);
  } catch {
    return { ok: false, reason: "owner_journal_unreadable: malformed_header" };
  }
  const owner = validateCodexJournalOwner(header, ownerThreadId);
  if (!owner.ok) return { ok: false, reason: owner.reason };
  return { ok: true, path: resolvedPath, raw };
}

/**
 * Reconcile one owned execution against the single owning Codex journal.
 *
 * @param {object} params
 * @param {string} params.ownerThreadId - native Codex owner thread id (UUIDv7)
 * @param {string} params.executionId - opaque tool-session/execution id (never a pid)
 * @param {string} params.repoRoot - expected repository root (absolute)
 * @param {string} params.cwd - expected working directory (absolute)
 * @param {string} [params.journalPath] - fixture-only explicit journal path; owner binding still applies
 * @param {Record<string,string|undefined>} [params.env]
 * @param {typeof import("node:fs")} [params.fs]
 * @param {Function} [params.processProbe] - optional spy; never called
 * @returns {object} `{ ok: true, status, reason, owner, execution, cleanup }` or `{ ok: false, reason }`
 */
export function resolveCodexExecutionEvidence({
  ownerThreadId,
  executionId,
  repoRoot,
  cwd,
  journalPath,
  env = process.env,
  fs = fsDefault,
  processProbe,
} = {}) {
  void processProbe;
  const owner = { threadId: typeof ownerThreadId === "string" ? ownerThreadId : null };

  if (typeof ownerThreadId !== "string" || !NATIVE_CODEX_THREAD_ID_PATTERN.test(ownerThreadId)) {
    return { ok: false, reason: "unsupported_owner_thread_id" };
  }
  if (!isNonBlankString(executionId)) return { ok: false, reason: "blank_execution_id" };
  if (!isNonBlankString(repoRoot) || !isNonBlankString(cwd)) return { ok: false, reason: "blank_repository_or_cwd" };

  const journal = readOwnerJournal({ ownerThreadId, journalPath, env, fs });
  if (!journal.ok) return journal;

  const canonicalRepoRoot = canonicalPath(repoRoot, fs);
  const canonicalCwd = canonicalPath(cwd, fs);
  if (!isWithin(canonicalRepoRoot, canonicalCwd)) {
    return unknownResult("wrong_repository", owner);
  }

  const targetExecutionId = executionId.trim();
  const valid = [];
  let malformed = false;
  let schemaDrift = false;
  let sawTerminal = false;
  let sawExecutionOtherOwner = false;
  let sawExecutionOtherCwd = false;
  let boundRecordCount = 0;
  let sawOwnerTerminalOtherExecution = false;

  for (const line of journal.raw.split("\n")) {
    if (line.trim() === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      malformed = true;
      continue;
    }
    if (record?.type !== "event_msg" || record?.payload?.type !== "item_completed") continue;
    const item = record?.payload?.item;
    if (item?.type !== "CommandExecution") continue;
    sawTerminal = true;

    // A terminal CommandExecution whose disclosed identity paths are absent is drift.
    if (!isNonBlankString(record?.payload?.thread_id) || !isNonBlankString(item?.process_id) || !isNonBlankString(item?.id)) {
      schemaDrift = true;
      continue;
    }

    const recordExecutionId = item.process_id;
    const nativeExecutionId = item.id;
    const executionMatches = recordExecutionId === targetExecutionId || nativeExecutionId === targetExecutionId;

    if (record?.payload?.thread_id !== ownerThreadId) {
      if (executionMatches) sawExecutionOtherOwner = true;
      continue;
    }

    if (!executionMatches) {
      sawOwnerTerminalOtherExecution = true;
      continue;
    }

    // Full disclosed-path validation for a record bound to owner + execution.
    const timestamp = record?.timestamp;
    const itemStatus = item?.status;
    const exitCode = item?.exit_code;
    const command = item?.command;
    const cwdRaw = item?.cwd;
    const output = item?.aggregated_output;
    if (!isNonBlankString(timestamp) || Number.isNaN(Date.parse(timestamp)) ||
        !isNonBlankString(itemStatus) || !Number.isSafeInteger(exitCode) ||
        !isStringArray(command) || !isNonBlankString(cwdRaw) || typeof output !== "string") {
      schemaDrift = true;
      continue;
    }
    const journalCwd = decodeJournalCwd(cwdRaw);
    if (journalCwd === null) {
      schemaDrift = true;
      continue;
    }
    boundRecordCount += 1;
    if (canonicalPath(journalCwd, fs) !== canonicalCwd) {
      sawExecutionOtherCwd = true;
      continue;
    }
    valid.push({
      id: recordExecutionId,
      nativeId: nativeExecutionId,
      timestamp,
      status: itemStatus,
      exitCode,
      command: [...command],
      cwd: canonicalPath(journalCwd, fs),
      cwdUri: cwdRaw,
      output: { bytes: Buffer.byteLength(output, "utf8"), text: output },
      ...(Number.isSafeInteger(record?.payload?.started_at_ms) ? { startedAtMs: record.payload.started_at_ms } : {}),
      ...(Number.isSafeInteger(record?.payload?.completed_at_ms) ? { completedAtMs: record.payload.completed_at_ms } : {}),
    });
  }

  if (malformed) return unknownResult("malformed_record", owner);
  if (schemaDrift) return unknownResult("schema_drift", owner);
  if (boundRecordCount > 1) return unknownResult("conflicting_terminal_records", owner);
  if (valid.length === 1) {
    return {
      ok: true,
      status: "completed",
      reason: "terminal_evidence_verified",
      owner,
      execution: valid[0],
      cleanup: cleanupDisposition("completed"),
    };
  }
  if (sawExecutionOtherCwd) return unknownResult("wrong_cwd", owner);
  if (sawExecutionOtherOwner) return unknownResult("wrong_owner_thread", owner);
  if (sawOwnerTerminalOtherExecution) return unknownResult("wrong_execution_id", owner);
  if (sawTerminal) return unknownResult("no_terminal_result", owner);
  return unknownResult("no_terminal_result", owner);
}

function unknownResult(reason, owner) {
  return {
    ok: true,
    status: "unknown",
    reason,
    owner,
    execution: null,
    cleanup: cleanupDisposition("unknown"),
  };
}

/**
 * Explicit unsupported-runtime-capability result (C1 fallback branch).
 *
 * A runtime that exposes neither a supported session/result API nor a readable
 * native journal reports this typed result instead of guessing.
 */
export function unsupportedRuntimeResult({ ownerThreadId } = {}) {
  return {
    ok: true,
    status: "unsupported",
    reason: "unsupported_runtime_capability",
    owner: { threadId: typeof ownerThreadId === "string" ? ownerThreadId : null },
    execution: null,
    cleanup: cleanupDisposition("unsupported"),
  };
}
