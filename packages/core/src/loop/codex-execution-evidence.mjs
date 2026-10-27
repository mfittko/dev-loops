/**
 * Read-only reconciliation of an owned Codex execution's terminal evidence.
 *
 * A stopped worker whose tool session already recorded a terminal
 * `CommandExecution` event is not a live process and not an unresolved cleanup
 * blocker. This adapter proves that from the owning native journal and reports a
 * typed result; it never probes, signals or controls a process.
 *
 * ## Disclosed schema
 *
 * The table below is the complete set of JSON pointers this adapter reads. It is
 * pinned from a real native journal, not a guessed schema. A record whose
 * disclosed pointer is absent, of another shape, or carrying an undisclosed
 * terminal-status value is schema drift and reconciles to `unknown`. Extra native
 * keys are deliberately ignored rather than treated as drift: every real record
 * carries bookkeeping paths this adapter has no evidence use for, so a literal
 * unknown-key rule would reject the journal the table was derived from.
 *
 * | field | pointer | shape |
 * | --- | --- | --- |
 * | eventDiscriminator | `/type` | `"event_msg"` |
 * | eventKind | `/payload/type` | `"item_completed"` |
 * | itemType | `/payload/item/type` | `"CommandExecution"` |
 * | ownerThreadId | `/payload/thread_id` | UUIDv7 string |
 * | executionId | `/payload/item/process_id` | opaque string |
 * | terminalTimestamp | `/timestamp` | ISO-8601 string |
 * | terminalStatus | `/payload/item/status` | completed or failed |
 * | exitCode | `/payload/item/exit_code` | integer |
 * | command | `/payload/item/command` | string array |
 * | cwd | `/payload/item/cwd` | file: URI string |
 * | retainedOutput | `/payload/item/aggregated_output` | string |
 *
 * This table is the only vocabulary for the disclosed schema: the `SCHEMA` data below
 * carries these same pointer and shape words, and a test asserts that every `SCHEMA`
 * row appears here, so the two copies cannot drift apart.
 *
 * `executionId` binds to the journal's `process_id` path, where the native journal
 * records a tool session identifier. Despite the name, that value stays an opaque
 * identifier: it is never parsed as, or turned into, an OS process identifier.
 */

import crypto from "node:crypto";
import fsDefault from "node:fs";
import path from "node:path";

import { isNativeCodexThreadId, resolveCodexRolloutJournal, resolveNativeCodexHome } from "./run-context.mjs";

/** Disclosed terminal-status values of a `CommandExecution` item. */
export const CODEX_TERMINAL_STATUSES = Object.freeze(["completed", "failed"]);

/**
 * The three typed reconciliation statuses.
 *
 * `completed` — exactly one terminal record binds to the supplied owner thread,
 * execution id, repository root and working directory. The recorded terminal
 * timestamp, exit status, exit code, command, cwd and a digest of the retained
 * output are reported unchanged; the journal is never rewritten.
 *
 * `unknown` — every other readable-journal outcome: absent, mismatched or
 * conflicting evidence, malformed records and schema drift. It is never reported
 * as completion and never as a live process.
 *
 * `unsupported` — this runtime exposes no native Codex session store, so neither a
 * supported session/result API nor the journal is available.
 *
 * A malformed *request* is also `unknown` with `reason: invalid_request`, but it is a
 * caller bug rather than an evidence outcome: it is reported before any journal read,
 * and a caller maps it to its own argument-error path (the CLI contract's exit 2 with
 * `{ ok: false, error }`) instead of to a typed evidence status.
 */
export const EVIDENCE_STATUSES = Object.freeze({
  COMPLETED: "completed",
  UNKNOWN: "unknown",
  UNSUPPORTED: "unsupported",
});

/** Every reason this adapter can report, so callers branch on constants, not prose. */
export const EVIDENCE_REASONS = Object.freeze({
  TERMINAL_EVIDENCE_VERIFIED: "terminal_evidence_verified",
  INVALID_REQUEST: "invalid_request",
  OWNER_JOURNAL_NOT_FOUND: "owner_journal_not_found",
  OWNER_JOURNAL_AMBIGUOUS: "owner_journal_ambiguous",
  OWNER_JOURNAL_UNREADABLE: "owner_journal_unreadable",
  OWNER_JOURNAL_NOT_REGULAR_FILE: "owner_journal_not_regular_file",
  OWNER_JOURNAL_DISCOVERY_BOUND: "owner_journal_discovery_bound",
  JOURNAL_EXCEEDS_BYTE_BOUND: "journal_exceeds_byte_bound",
  MALFORMED_RECORD: "malformed_record",
  OWNER_THREAD_MISMATCH: "owner_thread_mismatch",
  EXECUTION_ID_MISMATCH: "execution_id_mismatch",
  TERMINAL_RECORD_MISSING: "terminal_record_missing",
  CONFLICTING_TERMINAL_RECORDS: "conflicting_terminal_records",
  SCHEMA_DRIFT: "schema_drift",
  REPOSITORY_ROOT_MISMATCH: "repository_root_mismatch",
  CWD_MISMATCH: "cwd_mismatch",
  UNSUPPORTED_RUNTIME_CAPABILITY: "unsupported_runtime_capability",
});

/** Byte bound on the journal read; a larger journal cannot be verified whole. */
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Discovery failure codes mapped to this adapter's typed reasons.
 *
 * Every code the shared helper can return is listed. The lookup still fails closed
 * to `owner_journal_unreadable`, the same direction the header reader's prose mapping
 * takes, so a code added to discovery later can never surface here as `undefined`.
 */
const DISCOVERY_REASONS = Object.freeze({
  not_found: EVIDENCE_REASONS.OWNER_JOURNAL_NOT_FOUND,
  ambiguous: EVIDENCE_REASONS.OWNER_JOURNAL_AMBIGUOUS,
  unreadable: EVIDENCE_REASONS.OWNER_JOURNAL_UNREADABLE,
  not_regular_file: EVIDENCE_REASONS.OWNER_JOURNAL_NOT_REGULAR_FILE,
  entry_bound: EVIDENCE_REASONS.OWNER_JOURNAL_DISCOVERY_BOUND,
});

function discoveryReason(code) {
  return DISCOVERY_REASONS[code] ?? EVIDENCE_REASONS.OWNER_JOURNAL_UNREADABLE;
}

/**
 * The disclosed pointer table as data, in the documented shape vocabulary.
 *
 * These words are the table's own vocabulary (see the module header), so a caller
 * mirroring this data into the owning contract publishes what the header documents.
 */
const SCHEMA = Object.freeze([
  { field: "eventDiscriminator", pointer: "/type", shape: `"event_msg"` },
  { field: "eventKind", pointer: "/payload/type", shape: `"item_completed"` },
  { field: "itemType", pointer: "/payload/item/type", shape: `"CommandExecution"` },
  { field: "ownerThreadId", pointer: "/payload/thread_id", shape: "UUIDv7 string" },
  { field: "executionId", pointer: "/payload/item/process_id", shape: "opaque string" },
  { field: "terminalTimestamp", pointer: "/timestamp", shape: "ISO-8601 string" },
  { field: "terminalStatus", pointer: "/payload/item/status", shape: "completed or failed" },
  { field: "exitCode", pointer: "/payload/item/exit_code", shape: "integer" },
  { field: "command", pointer: "/payload/item/command", shape: "string array" },
  { field: "cwd", pointer: "/payload/item/cwd", shape: "file: URI string" },
  { field: "retainedOutput", pointer: "/payload/item/aggregated_output", shape: "string" },
]);

/** The disclosed JSON-pointer table, as data, for callers that mirror it into docs. */
export function describeEvidenceSchema() {
  return SCHEMA.map((row) => ({ ...row }));
}

/**
 * Cleanup disposition for a typed status.
 *
 * Only verified completion clears the blocker. Process probing is never
 * authorized: missing evidence authorizes neither probing nor cross-owner control.
 *
 * @param {string} status
 * @returns {{ blocker: false|"unknown", processProbeAllowed: false }}
 */
export function classifyCleanup(status) {
  return {
    blocker: status === EVIDENCE_STATUSES.COMPLETED ? false : "unknown",
    processProbeAllowed: false,
  };
}

function pointerValue(record, pointer) {
  let value = record;
  for (const key of pointer.split("/").slice(1)) {
    if (value === null || typeof value !== "object") return undefined;
    value = value[key];
  }
  return value;
}

function matchesShape(value, shape) {
  switch (shape) {
    case `"event_msg"`:
      return value === "event_msg";
    case `"item_completed"`:
      return value === "item_completed";
    case `"CommandExecution"`:
      return value === "CommandExecution";
    case "UUIDv7 string":
      return isNativeCodexThreadId(value);
    case "opaque string":
      return typeof value === "string" && value.trim().length > 0;
    case "ISO-8601 string":
      return typeof value === "string" && ISO_TIMESTAMP_RE.test(value) && !Number.isNaN(Date.parse(value));
    case "completed or failed":
      return CODEX_TERMINAL_STATUSES.includes(value);
    case "integer":
      return Number.isSafeInteger(value);
    case "string array":
      return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string");
    case "file: URI string":
      return typeof value === "string" && value.startsWith("file:") && fileUriToPath(value) !== null;
    case "string":
      return typeof value === "string";
    default:
      return false;
  }
}

function isDisclosedRecord(record) {
  return SCHEMA.every((row) => matchesShape(pointerValue(record, row.pointer), row.shape));
}

function isCommandExecutionItem(record) {
  return pointerValue(record, "/payload/item/type") === "CommandExecution";
}

function fileUriToPath(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    // A foreign host is not this filesystem's authority; never coerce it to a local path.
    if (url.host && url.host !== "localhost") return null;
    return path.resolve(decodeURIComponent(url.pathname));
  } catch {
    return null;
  }
}

function containedBy(root, candidate) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  return target === base || target.startsWith(base + path.sep);
}

function result(status, reason, owner, execution) {
  return { status, reason, owner, execution, cleanup: classifyCleanup(status) };
}

/**
 * Resolve the single owning journal for a native Codex thread.
 *
 * A runtime with no native session store at all is reported as `unsupported`: it
 * cannot offer a supported session/result API and cannot serve the journal either.
 * Every other failure is a typed owner-journal reason the caller maps to its own
 * exit-code contract: `owner_journal_not_found`, `owner_journal_ambiguous`,
 * `owner_journal_unreadable`, `owner_journal_not_regular_file` (a discovered name
 * that is not a regular file) and `owner_journal_discovery_bound` (the bounded
 * directory scan hit its entry cap) all fail closed, as does `invalid_request`.
 *
 * The `sessions/` root comes from the same shared resolution the discovery helper
 * uses, so this probe and that discovery always agree on the one native root.
 *
 * @param {object} params
 * @param {string} params.ownerThreadId - UUIDv7 owner thread identity.
 * @param {Record<string, string|undefined>} [params.env]
 * @param {typeof import("node:fs")} [params.fs]
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function resolveCodexExecutionJournal({ ownerThreadId, env = process.env, fs: fsImpl = fsDefault } = {}) {
  const unsupported = { ok: false, reason: EVIDENCE_REASONS.UNSUPPORTED_RUNTIME_CAPABILITY };
  if (!isNativeCodexThreadId(ownerThreadId)) {
    return { ok: false, reason: EVIDENCE_REASONS.INVALID_REQUEST };
  }
  const sessionsRoot = path.join(resolveNativeCodexHome(env), "sessions");
  let sessionsStat;
  try {
    sessionsStat = fsImpl.statSync(sessionsRoot);
  } catch (error) {
    return error?.code === "ENOENT" ? unsupported : { ok: false, reason: EVIDENCE_REASONS.OWNER_JOURNAL_UNREADABLE };
  }
  if (!sessionsStat.isDirectory()) return { ok: false, reason: EVIDENCE_REASONS.OWNER_JOURNAL_UNREADABLE };
  const found = resolveCodexRolloutJournal({ threadId: ownerThreadId, env, fs: fsImpl });
  return found.ok ? { ok: true, path: found.file } : { ok: false, reason: discoveryReason(found.code) };
}

/**
 * Reconcile one owned execution's terminal evidence from its journal.
 *
 * Read-only and deterministic: the journal is inspected and never written.
 *
 * `owner` echoes the request: `{ threadId, repoRoot, cwd }` as supplied.
 *
 * `execution` is the recorded terminal evidence, unchanged, when the status is
 * `completed`, and `null` otherwise:
 *
 * - `id` — the opaque execution/session identifier from `/payload/item/process_id`
 * - `exitStatus` — `/payload/item/status`, `completed` or `failed`
 * - `exitCode` — `/payload/item/exit_code`
 * - `endedAt` — `/timestamp`, the terminal ISO-8601 timestamp
 * - `command` — `/payload/item/command`, copied
 * - `cwd` — `/payload/item/cwd`, the recorded `file:` URI
 * - `retainedOutput` — `{ bytes, sha256 }` of `/payload/item/aggregated_output`
 *
 * A caller that serializes this result emits exactly
 * `{ ok, status, reason, owner, execution, cleanup }`.
 *
 * @param {object} params
 * @param {string} params.ownerThreadId - UUIDv7 owner thread identity.
 * @param {string} params.executionId - Opaque tool session identifier; compared exactly,
 *   so a padded or whitespace-padded value is a malformed request, not a mismatch.
 * @param {string} params.repoRoot - Absolute expected repository root.
 * @param {string} params.cwd - Absolute expected working directory (inside `repoRoot`).
 * @param {string} [params.journalPath] - Explicit owner journal (fixtures); owner
 *   binding is still validated field by field.
 * @param {Record<string, string|undefined>} [params.env]
 * @param {typeof import("node:fs")} [params.fs]
 * @returns {{ status: string, reason: string, owner: object, execution: object|null, cleanup: object }}
 */
export function reconcileCodexExecution({
  ownerThreadId,
  executionId,
  repoRoot,
  cwd,
  journalPath,
  env = process.env,
  fs: fsImpl = fsDefault,
} = {}) {
  const owner = { threadId: ownerThreadId ?? null, repoRoot: repoRoot ?? null, cwd: cwd ?? null };
  const unknown = (reason) => result(EVIDENCE_STATUSES.UNKNOWN, reason, owner, null);

  // A relative or home-prefixed root cannot be bound deterministically: path.resolve
  // would reinterpret it against whatever directory this process happens to run in.
  if (!isNativeCodexThreadId(ownerThreadId) ||
      typeof executionId !== "string" || executionId.trim() === "" || executionId !== executionId.trim() ||
      typeof repoRoot !== "string" || !path.isAbsolute(repoRoot) ||
      typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    return unknown(EVIDENCE_REASONS.INVALID_REQUEST);
  }

  const journal = journalPath ? { ok: true, path: journalPath } : resolveCodexExecutionJournal({ ownerThreadId, env, fs: fsImpl });
  if (!journal.ok) {
    return journal.reason === EVIDENCE_REASONS.UNSUPPORTED_RUNTIME_CAPABILITY
      ? result(EVIDENCE_STATUSES.UNSUPPORTED, journal.reason, owner, null)
      : unknown(journal.reason);
  }

  let journalStat;
  try {
    journalStat = fsImpl.statSync(journal.path);
  } catch {
    return unknown(EVIDENCE_REASONS.OWNER_JOURNAL_UNREADABLE);
  }
  if (!journalStat.isFile()) return unknown(EVIDENCE_REASONS.OWNER_JOURNAL_NOT_REGULAR_FILE);
  if (journalStat.size > MAX_JOURNAL_BYTES) return unknown(EVIDENCE_REASONS.JOURNAL_EXCEEDS_BYTE_BOUND);

  let text;
  try {
    text = fsImpl.readFileSync(journal.path, "utf8");
  } catch {
    return unknown(EVIDENCE_REASONS.OWNER_JOURNAL_UNREADABLE);
  }
  // The append-only journal can grow between the stat and the read; bound the bytes actually loaded.
  if (Buffer.byteLength(text, "utf8") > MAX_JOURNAL_BYTES) return unknown(EVIDENCE_REASONS.JOURNAL_EXCEEDS_BYTE_BOUND);

  const lines = text.split("\n");
  // An unterminated trailing line may be a record still being flushed. Dropping it can
  // only remove evidence, so it can never turn absence into completion.
  if (text.length > 0 && !text.endsWith("\n")) lines.pop();

  // An unparseable line inside the journal means absence of evidence cannot be proven.
  const items = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return unknown(EVIDENCE_REASONS.MALFORMED_RECORD);
    }
    if (isCommandExecutionItem(record)) items.push(record);
  }
  if (items.length === 0) return unknown(EVIDENCE_REASONS.TERMINAL_RECORD_MISSING);

  const executionItems = items.filter((record) => pointerValue(record, "/payload/item/process_id") === executionId);
  // A record for the requested execution whose owner pointer is absent or not a UUIDv7
  // is malformed, not an ownership mismatch: reporting it as owner_thread_mismatch would
  // label schema drift with the wrong failure class.
  if (executionItems.some((record) => !isNativeCodexThreadId(pointerValue(record, "/payload/thread_id")))) {
    return unknown(EVIDENCE_REASONS.SCHEMA_DRIFT);
  }

  const owned = items.filter((record) => pointerValue(record, "/payload/thread_id") === ownerThreadId);
  if (owned.length === 0) return unknown(EVIDENCE_REASONS.OWNER_THREAD_MISMATCH);

  const terminals = owned
    .filter((record) => pointerValue(record, "/payload/type") === "item_completed")
    .filter((record) => pointerValue(record, "/payload/item/process_id") === executionId);
  if (terminals.length === 0) {
    return unknown(executionItems.length > 0 ? EVIDENCE_REASONS.TERMINAL_RECORD_MISSING : EVIDENCE_REASONS.EXECUTION_ID_MISMATCH);
  }
  if (terminals.length > 1) return unknown(EVIDENCE_REASONS.CONFLICTING_TERMINAL_RECORDS);

  const record = terminals[0];
  if (!isDisclosedRecord(record)) return unknown(EVIDENCE_REASONS.SCHEMA_DRIFT);

  const recordedCwd = fileUriToPath(pointerValue(record, "/payload/item/cwd"));
  if (!containedBy(repoRoot, recordedCwd)) return unknown(EVIDENCE_REASONS.REPOSITORY_ROOT_MISMATCH);
  if (path.resolve(recordedCwd) !== path.resolve(cwd)) return unknown(EVIDENCE_REASONS.CWD_MISMATCH);

  const retainedOutput = pointerValue(record, "/payload/item/aggregated_output");
  return result(EVIDENCE_STATUSES.COMPLETED, EVIDENCE_REASONS.TERMINAL_EVIDENCE_VERIFIED, owner, {
    id: executionId,
    exitStatus: pointerValue(record, "/payload/item/status"),
    exitCode: pointerValue(record, "/payload/item/exit_code"),
    endedAt: pointerValue(record, "/timestamp"),
    command: [...pointerValue(record, "/payload/item/command")],
    cwd: pointerValue(record, "/payload/item/cwd"),
    retainedOutput: {
      bytes: Buffer.byteLength(retainedOutput, "utf8"),
      sha256: crypto.createHash("sha256").update(retainedOutput).digest("hex"),
    },
  });
}
