/**
 * Read-only reconciliation of an owned Codex execution's terminal evidence.
 *
 * A stopped worker whose tool session has already recorded a terminal
 * `CommandExecution` event is not a live process and not an unresolved cleanup
 * blocker. This adapter proves that from the owning native journal and reports a
 * typed result; it never probes, signals or controls a process.
 *
 * ## Disclosed schema
 *
 * The table below is the complete set of JSON pointers this adapter reads. It is
 * derived from the real native journal named by the owning issue (the
 * `CommandExecution` item for tool session `12938`), not from a guessed schema.
 * A record whose disclosed pointer is absent, of another shape, or carrying an
 * undisclosed terminal-status value is schema drift and reconciles to `unknown`.
 * Additional keys present in the native record are ignored, not drift: the native
 * journal carries bookkeeping paths this adapter has no evidence use for.
 *
 * | field | pointer | shape |
 * | --- | --- | --- |
 * | eventDiscriminator | `/type` | `"event_msg"` |
 * | eventKind | `/payload/type` | `"item_completed"` |
 * | itemType | `/payload/item/type` | `"CommandExecution"` |
 * | ownerThreadId | `/payload/thread_id` | UUIDv7 string |
 * | executionId | `/payload/item/process_id` | opaque string |
 * | terminalTimestamp | `/timestamp` | ISO-8601 string |
 * | terminalStatus | `/payload/item/status` | `completed` or `failed` |
 * | exitCode | `/payload/item/exit_code` | integer |
 * | command | `/payload/item/command` | string array |
 * | cwd | `/payload/item/cwd` | `file:` URI string |
 * | retainedOutput | `/payload/item/aggregated_output` | string |
 *
 * `executionId` binds to the journal's `process_id` path because that is where the
 * native journal records a tool session identifier. Despite the path name, that
 * value is an opaque identifier: it is never parsed as, or turned into, an OS
 * process identifier, and this module imports no process/spawn/signal surface.
 *
 * ## Typed result
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
 * `cleanup.processProbeAllowed` is `false` on every path, and only `completed`
 * clears `cleanup.blocker`.
 */

import crypto from "node:crypto";
import fsDefault from "node:fs";
import path from "node:path";

import { resolveCodexRolloutJournal } from "./run-context.mjs";

/** Disclosed terminal-status values of a `CommandExecution` item. */
export const CODEX_TERMINAL_STATUSES = Object.freeze(["completed", "failed"]);

/** The three typed reconciliation statuses. */
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

const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const DISCOVERY_REASONS = Object.freeze({
  not_found: EVIDENCE_REASONS.OWNER_JOURNAL_NOT_FOUND,
  ambiguous: EVIDENCE_REASONS.OWNER_JOURNAL_AMBIGUOUS,
  unreadable: EVIDENCE_REASONS.OWNER_JOURNAL_UNREADABLE,
  not_regular_file: EVIDENCE_REASONS.OWNER_JOURNAL_NOT_REGULAR_FILE,
  entry_bound: EVIDENCE_REASONS.OWNER_JOURNAL_DISCOVERY_BOUND,
});

const SCHEMA = Object.freeze([
  { field: "eventDiscriminator", pointer: "/type", shape: "event_msg" },
  { field: "eventKind", pointer: "/payload/type", shape: "item_completed" },
  { field: "itemType", pointer: "/payload/item/type", shape: "CommandExecution" },
  { field: "ownerThreadId", pointer: "/payload/thread_id", shape: "uuidv7" },
  { field: "executionId", pointer: "/payload/item/process_id", shape: "opaque_string" },
  { field: "terminalTimestamp", pointer: "/timestamp", shape: "iso_timestamp" },
  { field: "terminalStatus", pointer: "/payload/item/status", shape: "terminal_status" },
  { field: "exitCode", pointer: "/payload/item/exit_code", shape: "integer" },
  { field: "command", pointer: "/payload/item/command", shape: "string_array" },
  { field: "cwd", pointer: "/payload/item/cwd", shape: "file_uri" },
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
    case "event_msg":
    case "item_completed":
    case "CommandExecution":
      return value === shape;
    case "uuidv7":
      return typeof value === "string" && UUIDV7_RE.test(value);
    case "opaque_string":
      return typeof value === "string" && value.trim().length > 0;
    case "iso_timestamp":
      return typeof value === "string" && !Number.isNaN(Date.parse(value));
    case "terminal_status":
      return CODEX_TERMINAL_STATUSES.includes(value);
    case "integer":
      return Number.isSafeInteger(value);
    case "string_array":
      return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string");
    case "file_uri":
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
 * exit-code contract (`not_found`/`ambiguous`/`unreadable` fail closed).
 *
 * @param {object} params
 * @param {string} params.ownerThreadId - UUIDv7 owner thread identity.
 * @param {Record<string, string|undefined>} [params.env]
 * @param {typeof import("node:fs")} [params.fs]
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function resolveCodexExecutionJournal({ ownerThreadId, env = process.env, fs: fsImpl = fsDefault } = {}) {
  const unsupported = { ok: false, reason: EVIDENCE_REASONS.UNSUPPORTED_RUNTIME_CAPABILITY };
  if (typeof ownerThreadId !== "string" || !UUIDV7_RE.test(ownerThreadId)) {
    return { ok: false, reason: EVIDENCE_REASONS.INVALID_REQUEST };
  }
  const home = env?.CODEX_HOME || (env?.HOME ? path.join(env.HOME, ".codex") : null);
  const sessionsRoot = home ? path.join(home, "sessions") : null;
  if (!sessionsRoot) return unsupported;
  let sessionsStat;
  try {
    sessionsStat = fsImpl.statSync(sessionsRoot);
  } catch (error) {
    return error?.code === "ENOENT" ? unsupported : { ok: false, reason: EVIDENCE_REASONS.OWNER_JOURNAL_UNREADABLE };
  }
  if (!sessionsStat.isDirectory()) return unsupported;
  const found = resolveCodexRolloutJournal({ threadId: ownerThreadId, env, fs: fsImpl });
  return found.ok ? { ok: true, path: found.file } : { ok: false, reason: DISCOVERY_REASONS[found.code] ?? EVIDENCE_REASONS.OWNER_JOURNAL_UNREADABLE };
}

/**
 * Reconcile one owned execution's terminal evidence from its journal.
 *
 * Read-only and deterministic: the journal is inspected and never written. The
 * `processProbe` option exists so a caller can inject a probe spy and prove that
 * no reconciliation path invokes it; it is never called.
 *
 * @param {object} params
 * @param {string} params.ownerThreadId
 * @param {string} params.executionId - Opaque tool session identifier.
 * @param {string} params.repoRoot - Expected repository root.
 * @param {string} params.cwd - Expected working directory (inside `repoRoot`).
 * @param {string} [params.journalPath] - Explicit owner journal (fixtures); owner
 *   binding is still validated field by field.
 * @param {Record<string, string|undefined>} [params.env]
 * @param {typeof import("node:fs")} [params.fs]
 * @param {Function} [params.processProbe] - Never invoked.
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

  if (typeof ownerThreadId !== "string" || !UUIDV7_RE.test(ownerThreadId) ||
      typeof executionId !== "string" || executionId.trim() === "" ||
      typeof repoRoot !== "string" || repoRoot === "" ||
      typeof cwd !== "string" || cwd === "") {
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

  // An unparseable line means absence of evidence cannot be proven: fail closed.
  const items = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return unknown(EVIDENCE_REASONS.MALFORMED_RECORD);
    }
    if (isCommandExecutionItem(record)) items.push(record);
  }

  const owned = items.filter((record) => pointerValue(record, "/payload/thread_id") === ownerThreadId);
  if (items.length > 0 && owned.length === 0) return unknown(EVIDENCE_REASONS.OWNER_THREAD_MISMATCH);

  const terminals = owned
    .filter((record) => pointerValue(record, "/payload/type") === "item_completed")
    .filter((record) => pointerValue(record, "/payload/item/process_id") === executionId);
  if (terminals.length === 0) {
    const seen = owned.some((record) => pointerValue(record, "/payload/item/process_id") === executionId);
    return unknown(seen ? EVIDENCE_REASONS.TERMINAL_RECORD_MISSING : EVIDENCE_REASONS.EXECUTION_ID_MISMATCH);
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
