/**
 * Read-only reconciliation of an owned Codex execution's terminal evidence.
 *
 * A stopped worker whose tool session already recorded a terminal `CommandExecution`
 * event is not a live process and not an unresolved cleanup blocker. This adapter
 * proves that from the owning native journal and reports a typed result; it never
 * probes, signals or controls a process.
 *
 * ## Disclosed schema
 *
 * The table below is the complete set of terminal-record JSON pointers this adapter
 * reads, pinned from a real native journal. A record whose disclosed pointer is absent,
 * of another shape, or carrying an undisclosed terminal-status value is schema drift and
 * reconciles to `unknown`. Extra native keys are ignored, not drift: every real record
 * carries bookkeeping paths with no evidence use, so a literal unknown-key rule would
 * reject the very journal the table came from. The journal's first record is read too —
 * `/type` `"session_meta"`, `/payload/id` the owning thread — because discovery matches
 * the file name, which a copy or a rename can disagree with.
 *
 * | field | pointer | shape |
 * | --- | --- | --- |
 * | eventDiscriminator | `/type` | `"event_msg"` |
 * | eventKind | `/payload/type` | `"item_completed"` |
 * | itemType | `/payload/item/type` | `"CommandExecution"` |
 * | ownerThreadId | `/payload/thread_id` | UUIDv7 string |
 * | executionId | `/payload/item/process_id` | opaque string |
 * | terminalTimestamp | `/timestamp` | ISO 8601 string |
 * | terminalStatus | `/payload/item/status` | completed or failed |
 * | exitCode | `/payload/item/exit_code` | integer |
 * | command | `/payload/item/command` | string array |
 * | cwd | `/payload/item/cwd` | file: URI string |
 * | retainedOutput | `/payload/item/aggregated_output` | string |
 *
 * This table is the only vocabulary for the disclosed schema: the `SCHEMA` data below
 * carries these same field, pointer and shape words, and a test asserts every `SCHEMA`
 * row against its own row here, so the two copies cannot drift apart. `executionId`
 * binds to the journal's `process_id` path, which records a tool session identifier:
 * the value stays an opaque identifier, never parsed as or turned into an OS process
 * identifier.
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
 * `unknown` — absent, malformed, conflicting or unsupported records, the C2 row of the
 * owning issue (issue 2886). This adapter reports it as: evidence that is missing or
 * mis-bound to another owner thread, execution id, repository root or working
 * directory; an absent, reshaped or mis-owned journal header; malformed records;
 * conflicting terminal records; schema drift, an absent
 * or reshaped disclosed pointer; a record still landing at the journal's end; and every
 * owner journal it cannot reach — undiscoverable (not found, ambiguous or past the
 * discovery entry bound), unreadable, not a regular file, or over the 32 MiB read bound.
 * It is never reported as completion and never as a live process.
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
  JOURNAL_TAIL_IN_FLIGHT: "journal_tail_in_flight",
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

/**
 * Chunk size of the bounded journal read. The cap bounds the bytes read; the retained
 * chunk copies plus the join result reach roughly twice that.
 */
const READ_CHUNK_BYTES = 1024 * 1024;

/**
 * Read the journal through one descriptor with a hard byte cap.
 *
 * The append-only journal can grow between the preceding `stat` and this read, so a
 * whole-file read would allocate whatever the writer appended before any bound could be
 * checked. Reading in bounded chunks and stopping as soon as the cap is passed bounds the
 * I/O and the allocation regardless of how large the file has become.
 */
function readJournalText(fsImpl, file) {
  const chunks = [];
  let total = 0;
  let descriptor;
  try {
    descriptor = fsImpl.openSync(file, "r");
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    for (;;) {
      const read = fsImpl.readSync(descriptor, chunk, 0, chunk.length, total);
      if (read === 0) break;
      total += read;
      if (total > MAX_JOURNAL_BYTES) return { state: "overflow" };
      chunks.push(Buffer.from(chunk.subarray(0, read)));
    }
    return { state: "ok", text: Buffer.concat(chunks).toString("utf8") };
  } catch {
    return { state: "unreadable" };
  } finally {
    if (descriptor !== undefined) {
      try {
        fsImpl.closeSync(descriptor);
      } catch {
        // A close failure cannot change the result already read above.
      }
    }
  }
}

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
  { field: "terminalTimestamp", pointer: "/timestamp", shape: "ISO 8601 string" },
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
    case "ISO 8601 string":
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

/** The `type` of a journal's first record: the one carrying the session identity. */
const JOURNAL_HEADER_TYPE = "session_meta";

/**
 * Whether `line` parses as exactly one JSON record.
 *
 * The last line of a journal carries no terminator to prove the writer finished it, so its
 * content decides: a whole record is readable evidence, and anything else is a line still
 * landing, which keeps the journal unverifiable instead of dropping it.
 */
function isWholeRecord(line) {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

/** A supplied journal path is a path parameter like `repoRoot` and `cwd`: never relative. */
function isAbsolutePathWhenSupplied(value) {
  return value === undefined || (typeof value === "string" && path.isAbsolute(value));
}

function isTerminalRecord(record) {
  return pointerValue(record, "/payload/type") === "item_completed";
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
 * - `endedAt` — `/timestamp`, the terminal ISO 8601 timestamp
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
 * @param {string} [params.journalPath] - Absolute explicit owner journal (fixtures);
 *   owner binding is still validated field by field.
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
      typeof cwd !== "string" || !path.isAbsolute(cwd) ||
      !isAbsolutePathWhenSupplied(journalPath)) {
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

  const read = readJournalText(fsImpl, journal.path);
  if (read.state === "unreadable") return unknown(EVIDENCE_REASONS.OWNER_JOURNAL_UNREADABLE);
  // The append-only journal can grow between the stat and the read, so the bound is
  // enforced on the bytes actually read, not only on the pre-read stat.
  if (read.state === "overflow") return unknown(EVIDENCE_REASONS.JOURNAL_EXCEEDS_BYTE_BOUND);
  const text = read.text;

  const lines = text.split("\n");
  // A writer that has not flushed the final terminator leaves one unterminated line. Its
  // content decides whether that line is evidence: a whole record is, and any other
  // unterminated line is a tail still landing, so the journal stays unverifiable.
  if (text.length > 0 && !text.endsWith("\n") && !isWholeRecord(lines[lines.length - 1])) {
    return unknown(EVIDENCE_REASONS.JOURNAL_TAIL_IN_FLIGHT);
  }

  // An unparseable line inside the journal means absence of evidence cannot be proven.
  const records = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return unknown(EVIDENCE_REASONS.MALFORMED_RECORD);
    }
    records.push(record);
  }
  const items = records.filter(isCommandExecutionItem);
  if (items.length === 0) return unknown(EVIDENCE_REASONS.TERMINAL_RECORD_MISSING);

  // The first record is the journal header and the only authoritative statement of which
  // thread this file belongs to: discovery matches the file NAME, which a copy or a rename
  // can disagree with, so a terminal event alone never proves ownership.
  const [header] = records;
  if (header === undefined || pointerValue(header, "/type") !== JOURNAL_HEADER_TYPE) {
    return unknown(EVIDENCE_REASONS.SCHEMA_DRIFT);
  }
  const headerThreadId = pointerValue(header, "/payload/id");
  if (!isNativeCodexThreadId(headerThreadId)) return unknown(EVIDENCE_REASONS.SCHEMA_DRIFT);
  if (headerThreadId !== ownerThreadId) return unknown(EVIDENCE_REASONS.OWNER_THREAD_MISMATCH);

  // A `CommandExecution` item whose execution-id pointer is absent or not a non-empty
  // string is malformed, not a wrong execution: the equality filter below would drop it
  // and report `execution_id_mismatch`, labelling shape drift with the wrong failure class.
  if (items.some((record) => !matchesShape(pointerValue(record, "/payload/item/process_id"), "opaque string"))) {
    return unknown(EVIDENCE_REASONS.SCHEMA_DRIFT);
  }

  const executionItems = items.filter((record) => pointerValue(record, "/payload/item/process_id") === executionId);
  // A record for the requested execution whose event kind is absent or not a string is
  // malformed, not a non-terminal event: the terminal filter below would silently drop it
  // and let a surviving terminal hide the drift.
  if (executionItems.some((record) => !matchesShape(pointerValue(record, "/payload/type"), "opaque string"))) {
    return unknown(EVIDENCE_REASONS.SCHEMA_DRIFT);
  }
  // A record for the requested execution whose owner pointer is absent or not a UUIDv7
  // is malformed, not an ownership mismatch: reporting it as owner_thread_mismatch would
  // label schema drift with the wrong failure class.
  if (executionItems.some((record) => !isNativeCodexThreadId(pointerValue(record, "/payload/thread_id")))) {
    return unknown(EVIDENCE_REASONS.SCHEMA_DRIFT);
  }

  const owned = items.filter((record) => pointerValue(record, "/payload/thread_id") === ownerThreadId);
  if (owned.length === 0) return unknown(EVIDENCE_REASONS.OWNER_THREAD_MISMATCH);

  const terminals = owned
    .filter(isTerminalRecord)
    .filter((record) => pointerValue(record, "/payload/item/process_id") === executionId);
  if (terminals.length === 0) {
    // A terminal record for the requested execution under another valid owner thread is
    // the wrong-owner class, not missing evidence: the record exists and is mis-owned.
    if (executionItems.some(isTerminalRecord)) return unknown(EVIDENCE_REASONS.OWNER_THREAD_MISMATCH);
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
