/**
 * Contract tests for the read-only Codex terminal-evidence adapter.
 *
 * The disclosed JSON-pointer table in the implementation is derived from the real
 * native journal named by the owning issue. These fixtures mirror only that table:
 * the outer `event_msg` / `item_completed` record with its `CommandExecution` item.
 * No transcript text is committed as evidence; retained output is asserted by
 * digest and byte length, never copied into the result.
 */
import assert from "node:assert/strict";
import { afterAll as after, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CODEX_TERMINAL_STATUSES,
  EVIDENCE_REASONS,
  EVIDENCE_STATUSES,
  classifyCleanup,
  describeEvidenceSchema,
  reconcileCodexExecution,
  resolveCodexExecutionJournal,
} from "../src/loop/codex-execution-evidence.mjs";
import * as evidenceModule from "../src/loop/codex-execution-evidence.mjs";
import { isNativeCodexThreadId, resolveNativeCodexHome } from "../src/loop/run-context.mjs";

const OWNER = "01a15929-c860-7690-86d8-50f51506a786";
const OTHER_OWNER = "01a15922-5286-7900-b26d-ca2fe181cb85";
// A tool session identifier is an opaque string, never an OS process identifier.
const EXECUTION = "12938";
const REPO_ROOT = "/work/dev-loops";
const WORKTREE = `${REPO_ROOT}/tmp/worktrees/dev-loops/issue-2878`;
const RETAINED_OUTPUT = "0 passed, 0 skipped, 24 failed, 127.36 seconds\n";
const EXEC_ITEM_ID = "exec-a18f4b73-f369-4841-9a64-261d9fff244e";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function commandExecution({
  payloadType = "item_completed",
  threadId = OWNER,
  executionId = EXECUTION,
  status = "failed",
  exitCode = 1,
  cwd = `file://${WORKTREE}`,
  command = ["/bin/zsh", "-lc", "bun test test/loop/pr-worktree-binding.test.mjs"],
  retainedOutput = RETAINED_OUTPUT,
  timestamp = "2026-10-20T11:59:37.885Z",
  item = {},
} = {}) {
  return {
    timestamp,
    ordinal: 185,
    type: "event_msg",
    payload: {
      type: payloadType,
      thread_id: threadId,
      turn_id: "01a15929-c8f8-7922-8edf-06747fcdef2c",
      item: {
        type: "CommandExecution",
        id: EXEC_ITEM_ID,
        process_id: executionId,
        command,
        cwd,
        parsed_cmd: [],
        source: "unified_exec_startup",
        status,
        aggregated_output: retainedOutput,
        exit_code: exitCode,
        ...item,
      },
    },
  };
}

/** Worker/session stop marker: carries no terminal CommandExecution evidence. */
function workerStop(timestamp = "2026-10-20T11:58:44.000Z") {
  return { timestamp, type: "event_msg", payload: { type: "task_complete", thread_id: OWNER } };
}

const tempRoots = [];
function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-evidence-"));
  tempRoots.push(root);
  return root;
}

function writeJournal(records, { root = makeTempRoot() } = {}) {
  const file = path.join(root, "journal.jsonl");
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return file;
}

function reconcile(journalPath, overrides = {}) {
  return reconcileCodexExecution({
    journalPath,
    ownerThreadId: OWNER,
    executionId: EXECUTION,
    repoRoot: REPO_ROOT,
    cwd: WORKTREE,
    ...overrides,
  });
}

function assertUnknown(result, reason) {
  assert.equal(result.status, EVIDENCE_STATUSES.UNKNOWN, `expected unknown, got ${result.status} (${result.reason})`);
  assert.equal(result.reason, reason);
  assert.equal(result.execution, null);
  assert.deepEqual(result.cleanup, { blocker: "unknown", processProbeAllowed: false });
}

// ---------------------------------------------------------------------------
// C1 — a terminal record that lands after the worker stopped is completion.
// ---------------------------------------------------------------------------

test("C1: a terminal record after the worker stopped reports completed with the recorded evidence", () => {
  const file = writeJournal([workerStop(), commandExecution()]);
  const before = sha256(fs.readFileSync(file));

  const result = reconcile(file);

  assert.equal(result.status, EVIDENCE_STATUSES.COMPLETED);
  assert.equal(result.reason, EVIDENCE_REASONS.TERMINAL_EVIDENCE_VERIFIED);
  assert.equal(result.owner.threadId, OWNER);
  assert.equal(result.execution.id, EXECUTION);
  // The journal recorded a failed run; the typed status reports verified evidence, not success.
  assert.equal(result.execution.exitStatus, "failed");
  assert.equal(result.execution.exitCode, 1);
  assert.equal(result.execution.endedAt, "2026-10-20T11:59:37.885Z");
  assert.deepEqual(result.execution.command, ["/bin/zsh", "-lc", "bun test test/loop/pr-worktree-binding.test.mjs"]);
  assert.equal(result.execution.cwd, `file://${WORKTREE}`);
  assert.deepEqual(result.execution.retainedOutput, {
    bytes: Buffer.byteLength(RETAINED_OUTPUT, "utf8"),
    sha256: sha256(RETAINED_OUTPUT),
  });
  assert.deepEqual(result.cleanup, { blocker: false, processProbeAllowed: false });
  // Retained output is referenced by digest, never copied into the result.
  assert.ok(!JSON.stringify(result).includes("24 failed"));
  assert.equal(sha256(fs.readFileSync(file)), before);
});

test("C1 alternative: a runtime with no native journal store reports unsupported", () => {
  const codexHome = makeTempRoot(); // exists, but carries no `sessions/` store
  const result = reconcileCodexExecution({
    ownerThreadId: OWNER,
    executionId: EXECUTION,
    repoRoot: REPO_ROOT,
    cwd: WORKTREE,
    env: { CODEX_HOME: codexHome },
  });
  assert.equal(result.status, EVIDENCE_STATUSES.UNSUPPORTED);
  assert.equal(result.reason, EVIDENCE_REASONS.UNSUPPORTED_RUNTIME_CAPABILITY);
  assert.equal(result.execution, null);
  assert.deepEqual(result.cleanup, { blocker: "unknown", processProbeAllowed: false });
  assert.deepEqual(classifyCleanup(EVIDENCE_STATUSES.UNSUPPORTED), { blocker: "unknown", processProbeAllowed: false });
});

test("C1: the owner journal is discovered from the bounded native session layout", () => {
  const codexHome = makeTempRoot();
  const createdAt = Number.parseInt(OWNER.slice(0, 13).replaceAll("-", ""), 16);
  const date = new Date(createdAt).toISOString().slice(0, 10);
  const directory = path.join(codexHome, "sessions", ...date.split("-"));
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `rollout-2026-10-20T13-54-33-${OWNER}.jsonl`);
  fs.writeFileSync(file, [workerStop(), commandExecution()].map((r) => JSON.stringify(r)).join("\n") + "\n");

  const env = { CODEX_HOME: codexHome };
  const resolved = resolveCodexExecutionJournal({ ownerThreadId: OWNER, env });
  assert.deepEqual(resolved, { ok: true, path: file });
  assert.equal(resolveCodexExecutionJournal({ ownerThreadId: OWNER, env: { CODEX_HOME: makeTempRoot() + "/missing" } }).reason,
    EVIDENCE_REASONS.UNSUPPORTED_RUNTIME_CAPABILITY);

  const result = reconcileCodexExecution({
    ownerThreadId: OWNER, executionId: EXECUTION, repoRoot: REPO_ROOT, cwd: WORKTREE, env,
  });
  assert.equal(result.status, EVIDENCE_STATUSES.COMPLETED);
  assert.equal(result.execution.exitCode, 1);
});

// ---------------------------------------------------------------------------
// C2 — one negative fixture per failure class, each typed unknown.
// ---------------------------------------------------------------------------

const NEGATIVES = [
  {
    name: "wrong owner thread",
    records: [commandExecution({ threadId: OTHER_OWNER })],
    reason: EVIDENCE_REASONS.OWNER_THREAD_MISMATCH,
  },
  {
    name: "wrong execution id",
    records: [commandExecution({ executionId: "40971" })],
    reason: EVIDENCE_REASONS.EXECUTION_ID_MISMATCH,
  },
  {
    name: "wrong working directory",
    records: [commandExecution({ cwd: `file://${REPO_ROOT}/tmp/worktrees/dev-loops/issue-2877` })],
    reason: EVIDENCE_REASONS.CWD_MISMATCH,
  },
  {
    name: "wrong repository root",
    records: [commandExecution({ cwd: "file:///work/other-repo/tmp/worktrees/dev-loops/issue-2878" })],
    reason: EVIDENCE_REASONS.REPOSITORY_ROOT_MISMATCH,
  },
  {
    name: "missing terminal record",
    records: [workerStop(), commandExecution({ payloadType: "item_started", item: { status: undefined, exit_code: undefined } })],
    reason: EVIDENCE_REASONS.TERMINAL_RECORD_MISSING,
  },
  {
    name: "schema drift on the terminal status",
    records: [commandExecution({ status: "interrupted" })],
    reason: EVIDENCE_REASONS.SCHEMA_DRIFT,
  },
  {
    name: "schema drift on an undisclosed exit code",
    records: [commandExecution({ item: { exit_code: undefined } })],
    reason: EVIDENCE_REASONS.SCHEMA_DRIFT,
  },
  {
    name: "schema drift on an undisclosed working-directory form",
    records: [commandExecution({ cwd: WORKTREE })],
    reason: EVIDENCE_REASONS.SCHEMA_DRIFT,
  },
  {
    name: "two conflicting terminal records",
    records: [commandExecution(), commandExecution({ exitCode: 0, status: "completed", timestamp: "2026-10-20T11:59:41.101Z" })],
    reason: EVIDENCE_REASONS.CONFLICTING_TERMINAL_RECORDS,
  },
];

for (const negative of NEGATIVES) {
  test(`C2: ${negative.name} stays typed unknown and leaves the journal bytes unchanged`, () => {
    const file = writeJournal(negative.records);
    const before = sha256(fs.readFileSync(file));
    assertUnknown(reconcile(file), negative.reason);
    assert.equal(sha256(fs.readFileSync(file)), before);
  });
}

test("C2: malformed JSON stays typed unknown and leaves the journal bytes unchanged", () => {
  const root = makeTempRoot();
  const file = path.join(root, "journal.jsonl");
  const body = `${JSON.stringify(workerStop())}\n{"type":"event_msg","payload":{"item":{"type":"CommandExecu\n`;
  fs.writeFileSync(file, body);
  const before = sha256(fs.readFileSync(file));
  assertUnknown(reconcile(file), EVIDENCE_REASONS.MALFORMED_RECORD);
  assert.equal(sha256(fs.readFileSync(file)), before);
});

test("C2: an unterminated tail is decided by its content, never by the writer's final newline", () => {
  const root = makeTempRoot();
  const file = path.join(root, "journal.jsonl");
  const terminal = JSON.stringify(commandExecution());
  // Every line terminated, one terminal record: completion.
  fs.writeFileSync(file, `${JSON.stringify(workerStop())}\n${terminal}\n`);
  assert.equal(reconcile(file).status, EVIDENCE_STATUSES.COMPLETED);
  // A whole record without a final newline is a record, not a torn tail.
  fs.writeFileSync(file, terminal);
  assert.equal(reconcile(file).status, EVIDENCE_STATUSES.COMPLETED);
  // The same corrupt bytes reconcile to the same typed reason with and without a newline.
  for (const body of [`${terminal}\nnot json`, `${terminal}\nnot json\n`]) {
    fs.writeFileSync(file, body);
    assertUnknown(reconcile(file), EVIDENCE_REASONS.MALFORMED_RECORD);
  }
  // A record still landing is never completion: a torn second terminal record keeps the
  // journal unverifiable instead of reducing two terminals to one.
  const torn = `${terminal}\n{"type":"event_msg","payload":{"type":"item_completed","thread_id":"${OWNER}","item":{"type":"CommandExecution","process_id":"${EXECUTION}"`;
  fs.writeFileSync(file, torn);
  const pending = reconcile(file);
  assertUnknown(pending, EVIDENCE_REASONS.JOURNAL_TAIL_IN_FLIGHT);
  assert.equal(pending.cleanup.blocker, "unknown");
  // Once that second terminal record lands, the same journal is the conflict class.
  fs.writeFileSync(file, `${torn},"exit_code":1}}}\n`);
  assertUnknown(reconcile(file), EVIDENCE_REASONS.CONFLICTING_TERMINAL_RECORDS);
  // A tail that cannot become a terminal record is tolerated, so the journal still
  // reconciles from its terminated evidence.
  fs.writeFileSync(file, `${terminal}\n{"timestamp":"2026-10-20T11:58:44.000Z","type":"event_msg","payload":{"type":"token_count"`);
  assert.equal(reconcile(file).status, EVIDENCE_STATUSES.COMPLETED);
});

test("C2: a cwd whose file: URI authority or encoding cannot be trusted stays typed unknown", () => {
  // Accepted: the recorded cwd is this filesystem's authority and decodes cleanly.
  assert.equal(reconcile(writeJournal([commandExecution()])).status, EVIDENCE_STATUSES.COMPLETED);
  // Rejected: another host's authority is never coerced into a local path, which would
  // otherwise satisfy the repository and cwd binding.
  assertUnknown(reconcile(writeJournal([commandExecution({ cwd: `file://evil.example${WORKTREE}` })])),
    EVIDENCE_REASONS.SCHEMA_DRIFT);
  // Rejected: a pathname that cannot be decoded is not a path this adapter can bind.
  assertUnknown(reconcile(writeJournal([commandExecution({ cwd: `file://${REPO_ROOT}/%zz` })])),
    EVIDENCE_REASONS.SCHEMA_DRIFT);
});

test("C2: a journal that is not a regular file or cannot be stat'ed reports its own reason", () => {
  const directory = path.join(makeTempRoot(), "journal-as-directory");
  fs.mkdirSync(directory);
  // A supplied path that is not a regular file is its own class, not a read failure.
  assertUnknown(reconcile(directory), EVIDENCE_REASONS.OWNER_JOURNAL_NOT_REGULAR_FILE);
  // A stat that fails is unreadable rather than a guess about the path.
  const denied = { ...fs, statSync() { throw Object.assign(new Error("denied"), { code: "EACCES" }); } };
  assertUnknown(reconcile(writeJournal([commandExecution()]), { fs: denied }), EVIDENCE_REASONS.OWNER_JOURNAL_UNREADABLE);
});

test("C2: a journal with no execution records reports missing terminal evidence", () => {
  for (const records of [[], [workerStop()]]) {
    assertUnknown(reconcile(writeJournal(records)), EVIDENCE_REASONS.TERMINAL_RECORD_MISSING);
  }
  const root = makeTempRoot();
  const empty = path.join(root, "empty.jsonl");
  fs.writeFileSync(empty, "");
  assertUnknown(reconcile(empty), EVIDENCE_REASONS.TERMINAL_RECORD_MISSING);
});

test("C2: the positive binding is what rejects the mismatches, not a permissive match", () => {
  // Same records, correct binding: completed. Each negative above differs in exactly one field.
  const records = [commandExecution()];
  assert.equal(reconcile(writeJournal(records)).status, EVIDENCE_STATUSES.COMPLETED);
  // A sibling worktree of the same repository is still a different cwd.
  const sibling = reconcile(writeJournal([commandExecution({ cwd: `file://${REPO_ROOT}/tmp/worktrees/dev-loops/issue-2950` })]));
  assertUnknown(sibling, EVIDENCE_REASONS.CWD_MISMATCH);
});

test("C2: an unresolvable owner journal stays typed unknown and never guesses", () => {
  const root = makeTempRoot();
  const codexHome = path.join(root, "codex");
  const ambiguousDir = path.join(codexHome, "sessions", ...new Date(Number.parseInt(OWNER.slice(0, 13).replaceAll("-", ""), 16)).toISOString().slice(0, 10).split("-"));
  fs.mkdirSync(ambiguousDir, { recursive: true });
  for (const prefix of ["a", "b"]) {
    fs.writeFileSync(path.join(ambiguousDir, `rollout-2026-10-20T13-54-33-${OWNER}.jsonl`.replace("rollout", `rollout-${prefix}`)),
      [commandExecution()].map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  const ambiguous = resolveCodexExecutionJournal({ ownerThreadId: OWNER, env: { CODEX_HOME: codexHome } });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, EVIDENCE_REASONS.OWNER_JOURNAL_AMBIGUOUS);

  const base = { ownerThreadId: OWNER, executionId: EXECUTION, repoRoot: REPO_ROOT, cwd: WORKTREE };
  assertUnknown(reconcileCodexExecution({ ...base, env: { CODEX_HOME: codexHome } }), EVIDENCE_REASONS.OWNER_JOURNAL_AMBIGUOUS);
  const empty = makeTempRoot();
  fs.mkdirSync(path.join(empty, "sessions"), { recursive: true });
  assertUnknown(reconcileCodexExecution({ ...base, env: { CODEX_HOME: empty } }), EVIDENCE_REASONS.OWNER_JOURNAL_NOT_FOUND);
  const unreadable = { ...fs, opendirSync() { throw Object.assign(new Error("boom"), { code: "EACCES" }); } };
  assertUnknown(reconcile(fileWithRecords(), { fs: unreadable, journalPath: undefined, env: { CODEX_HOME: codexHome }, ownerThreadId: OWNER }),
    EVIDENCE_REASONS.OWNER_JOURNAL_UNREADABLE);
});

test("C2: a terminal record for the requested execution under another owner is a wrong-owner report", () => {
  const ownerActivity = commandExecution({ payloadType: "item_started", executionId: "999", item: { status: undefined, exit_code: undefined } });
  const records = [ownerActivity, commandExecution({ threadId: OTHER_OWNER })];
  // The requested execution's terminal record exists and is mis-owned, so the class is
  // the wrong owner thread rather than missing evidence.
  assertUnknown(reconcile(writeJournal(records)), EVIDENCE_REASONS.OWNER_THREAD_MISMATCH);
  // The owner-only sibling reports the execution-id class, so the mis-owned terminal is
  // what moves the reason.
  assertUnknown(reconcile(writeJournal([ownerActivity])), EVIDENCE_REASONS.EXECUTION_ID_MISMATCH);
});

test("a relative journal path is a malformed request, like a relative root or cwd", () => {
  const file = writeJournal([commandExecution()]);
  // Accepted: an absolute journal path binds normally.
  assert.equal(reconcile(file).status, EVIDENCE_STATUSES.COMPLETED);
  // Rejected: one path rule for all three path parameters, so a relative value is never
  // resolved against whatever directory this process happens to run in.
  for (const journalPath of ["journal.jsonl", "./journal.jsonl", "~/journal.jsonl"]) {
    assertUnknown(reconcile(journalPath), EVIDENCE_REASONS.INVALID_REQUEST);
  }
});

function fileWithRecords() {
  return writeJournal([commandExecution()]);
}

test("C2: a journal above the byte bound stays typed unknown and is never read whole", () => {
  const file = writeJournal([commandExecution()]);
  let readAttempts = 0;
  const huge = {
    ...fs,
    statSync(...args) {
      const stat = fs.statSync(...args);
      return { ...stat, size: 64 * 1024 * 1024, isFile: () => true };
    },
    readFileSync(...args) { readAttempts++; return fs.readFileSync(...args); },
  };
  assertUnknown(reconcile(file, { fs: huge }), EVIDENCE_REASONS.JOURNAL_EXCEEDS_BYTE_BOUND);
  assert.equal(readAttempts, 0);
});

test("C2: a journal that grows past the byte bound between stat and read stays typed unknown", () => {
  // The append-only journal can cross the bound after the pre-read stat. The bound is
  // re-checked on the loaded bytes, so a small stat must not let the read decide.
  const file = writeJournal([commandExecution()]);
  const grownFs = {
    ...fs,
    statSync: () => ({ size: 4096, isFile: () => true }),
    readFileSync: () => "x".repeat(32 * 1024 * 1024 + 1),
  };
  assertUnknown(reconcile(file, { fs: grownFs }), EVIDENCE_REASONS.JOURNAL_EXCEEDS_BYTE_BOUND);
});

test("C2: a sessions entry that is not a directory is unreadable, not unsupported", () => {
  const codexHome = makeTempRoot();
  fs.writeFileSync(path.join(codexHome, "sessions"), "not a directory");
  const env = { CODEX_HOME: codexHome };
  // A native store that exists but cannot be entered is a typed unknown, never the
  // "this runtime has no native store" unsupported report. The branch decides on the
  // stat alone, so the scan is never entered: a filesystem that refuses to enumerate
  // still yields the unreadable reason rather than a discovery failure.
  let enumerations = 0;
  const noEnumeration = { ...fs, opendirSync() { enumerations++; throw new Error("must not enumerate"); } };
  assert.deepEqual(resolveCodexExecutionJournal({ ownerThreadId: OWNER, env, fs: noEnumeration }),
    { ok: false, reason: EVIDENCE_REASONS.OWNER_JOURNAL_UNREADABLE });
  assert.equal(enumerations, 0);
  assert.deepEqual(resolveCodexExecutionJournal({ ownerThreadId: OWNER, env }),
    { ok: false, reason: EVIDENCE_REASONS.OWNER_JOURNAL_UNREADABLE });
  assertUnknown(reconcileCodexExecution({
    ownerThreadId: OWNER, executionId: EXECUTION, repoRoot: REPO_ROOT, cwd: WORKTREE, env,
  }), EVIDENCE_REASONS.OWNER_JOURNAL_UNREADABLE);
});

test("C2: the adapter probes the same native root the shared discovery helper scans", () => {
  // One home resolution: the probe and the scan cannot separate onto two roots, so an
  // empty `<CODEX_HOME>/sessions` is "not found" (the helper's answer), not "unsupported".
  const codexHome = makeTempRoot();
  const env = { CODEX_HOME: codexHome };
  assert.equal(resolveNativeCodexHome(env), codexHome);
  const request = { ownerThreadId: OWNER, executionId: EXECUTION, repoRoot: REPO_ROOT, cwd: WORKTREE, env };
  const noStore = reconcileCodexExecution(request);
  assert.equal(noStore.status, EVIDENCE_STATUSES.UNSUPPORTED);
  assert.equal(noStore.reason, EVIDENCE_REASONS.UNSUPPORTED_RUNTIME_CAPABILITY);
  fs.mkdirSync(path.join(codexHome, "sessions"), { recursive: true });
  assertUnknown(reconcileCodexExecution(request), EVIDENCE_REASONS.OWNER_JOURNAL_NOT_FOUND);
});

test("C2: the adapter and the discovery helper accept and reject the same owner ids", () => {
  for (const id of [OWNER, OTHER_OWNER, "unknown", OWNER.toUpperCase(), OWNER.slice(0, -1), ""] ) {
    const accepted = isNativeCodexThreadId(id);
    const resolved = resolveCodexExecutionJournal({ ownerThreadId: id, env: { CODEX_HOME: makeTempRoot() } });
    assert.equal(resolved.reason,
      accepted ? EVIDENCE_REASONS.UNSUPPORTED_RUNTIME_CAPABILITY : EVIDENCE_REASONS.INVALID_REQUEST,
      `owner id ${JSON.stringify(id)} must be ${accepted ? "accepted" : "rejected"} by both readers`);
  }
});

test("C2: a CommandExecution owner pointer that is absent or not a UUIDv7 is schema drift", () => {
  // Four input forms: two accepted ownership outcomes, two malformed records. A record
  // for the requested execution whose owner pointer is absent or wrongly shaped is a
  // drift record, never an ownership mismatch.
  const accepted = [
    { records: [commandExecution()], status: EVIDENCE_STATUSES.COMPLETED },
    { records: [commandExecution({ threadId: OTHER_OWNER })], reason: EVIDENCE_REASONS.OWNER_THREAD_MISMATCH },
  ];
  for (const fixture of accepted) {
    const result = reconcile(writeJournal(fixture.records));
    if (fixture.status) assert.equal(result.status, fixture.status);
    else assertUnknown(result, fixture.reason);
  }
  for (const records of [
    [withoutOwnerPointer()], // pointer absent
    [commandExecution({ threadId: 12938 })], // pointer not a string
  ]) {
    assertUnknown(reconcile(writeJournal(records)), EVIDENCE_REASONS.SCHEMA_DRIFT);
  }
});

/** A CommandExecution record for the requested execution with no owner pointer at all. */
function withoutOwnerPointer() {
  const record = commandExecution();
  delete record.payload.thread_id;
  return record;
}

// ---------------------------------------------------------------------------
// C3 — an uncollected session is never evidence of a live process.
// ---------------------------------------------------------------------------

test("C3(a): only completed clears the cleanup blocker, and probing is never allowed", () => {
  assert.deepEqual(classifyCleanup(EVIDENCE_STATUSES.COMPLETED), { blocker: false, processProbeAllowed: false });
  assert.deepEqual(classifyCleanup(EVIDENCE_STATUSES.UNKNOWN), { blocker: "unknown", processProbeAllowed: false });
  assert.deepEqual(classifyCleanup(EVIDENCE_STATUSES.UNSUPPORTED), { blocker: "unknown", processProbeAllowed: false });
  assert.deepEqual(classifyCleanup(undefined), { blocker: "unknown", processProbeAllowed: false });
});

test("C3(b): the adapter exposes no process-probe entry point on any reconciliation path", () => {
  // Stronger than an injected spy that is never called: the module cannot be handed a
  // probe at all, so no caller and no future path can probe through this surface.
  for (const name of Object.keys(evidenceModule)) {
    assert.ok(!/probe|spawn|kill|signal|pid/i.test(name), `unexpected process-shaped export ${name}`);
  }
  const paths = [
    [workerStop(), commandExecution()],
    [commandExecution({ threadId: OTHER_OWNER })],
    [commandExecution({ executionId: "40971" })],
    [commandExecution({ cwd: `file://${REPO_ROOT}/elsewhere` })],
    [commandExecution({ status: "interrupted" })],
  ];
  for (const records of paths) {
    const result = reconcile(writeJournal(records));
    assert.equal(result.cleanup.processProbeAllowed, false);
    assert.ok(!Object.keys(result.cleanup).some((key) => /probe/i.test(key) && key !== "processProbeAllowed"));
  }
  const unsupported = reconcileCodexExecution({
    ownerThreadId: OWNER, executionId: EXECUTION, repoRoot: REPO_ROOT, cwd: WORKTREE,
    env: { CODEX_HOME: makeTempRoot() },
  });
  assert.equal(unsupported.status, EVIDENCE_STATUSES.UNSUPPORTED);
});

test("C3(c): the adapter imports no process, spawn or kill surface", () => {
  const source = fs.readFileSync(new URL("../src/loop/codex-execution-evidence.mjs", import.meta.url), "utf8");
  for (const forbidden of [/node:child_process/, /\bspawn\w*\(/, /\bexecFile\w*\(/, /\.kill\(/, /process\.pid/, /\bpid\b/]) {
    assert.ok(!forbidden.test(source), `adapter source must not match ${forbidden}`);
  }
});

test("C3(d): a numeric session id stays an opaque string identifier", () => {
  const result = reconcile(writeJournal([commandExecution()]));
  assert.equal(typeof result.execution.id, "string");
  assert.equal(result.execution.id, "12938");
  // No pid-shaped field is ever derived from it.
  assert.ok(!Object.keys(result.execution).some((key) => /pid/i.test(key)));
  assert.ok(!JSON.stringify(result).includes('"pid"'));
  // Even a purely numeric identifier is never coerced to a number.
  // A non-string identifier is rejected as a malformed request, never coerced.
  assertUnknown(reconcile(writeJournal([commandExecution()]), { executionId: 12938 }), EVIDENCE_REASONS.INVALID_REQUEST);
  const numeric = reconcile(writeJournal([commandExecution({ executionId: "12938" })]), { executionId: "12938" });
  assert.equal(numeric.execution.id, "12938");
  assert.notStrictEqual(numeric.execution.id, 12938);
});

// ---------------------------------------------------------------------------
// Disclosed schema.
// ---------------------------------------------------------------------------

/**
 * Parse the module header's disclosed table into `field -> { pointer, shape }`.
 *
 * Row-aligned on purpose: a whole-docblock substring test cannot see a single row's
 * field, pointer or shape change when another row carries the same words.
 */
function parseDocblockTable(source) {
  const rows = new Map();
  for (const line of source.split("*/")[0].split("\n")) {
    const tableLine = line.match(/^\s*\*\s*\|(.+)\|\s*$/u);
    if (tableLine === null) continue;
    const cells = tableLine[1].split("|").map((cell) => cell.trim());
    if (cells.length !== 3 || !cells[1].startsWith("`")) continue;
    rows.set(cells[0], { pointer: cells[1].replaceAll("`", ""), shape: cells[2].replaceAll("`", "") });
  }
  return rows;
}

/** Every row-aligned way the documented copy and the data copy disagree. */
function schemaRowDrift(schema, documented) {
  const drift = [];
  const documentedFields = [...documented.keys()].join(",");
  const schemaFields = schema.map((row) => row.field).join(",");
  if (documentedFields !== schemaFields) drift.push(`rows [${documentedFields}] != [${schemaFields}]`);
  for (const row of schema) {
    const documentedRow = documented.get(row.field);
    if (documentedRow === undefined) {
      drift.push(`${row.field} is undocumented`);
      continue;
    }
    if (documentedRow.pointer !== row.pointer) drift.push(`${row.field} pointer`);
    if (documentedRow.shape !== row.shape) drift.push(`${row.field} shape`);
  }
  return drift;
}

test("the disclosed schema table is one vocabulary, and every SCHEMA row matches its own docblock row", () => {
  const source = fs.readFileSync(new URL("../src/loop/codex-execution-evidence.mjs", import.meta.url), "utf8");
  const table = describeEvidenceSchema();
  assert.deepEqual(table.map((row) => row.field), [
    "eventDiscriminator", "eventKind", "itemType", "ownerThreadId", "executionId",
    "terminalTimestamp", "terminalStatus", "exitCode", "command", "cwd", "retainedOutput",
  ]);
  // The docblock is the documented table; SCHEMA is its data form. Rows are compared one
  // against one, in order, so neither copy can change a row alone.
  const documented = parseDocblockTable(source);
  assert.deepEqual(schemaRowDrift(table, documented), []);
  // A single row's shape edit is drift even when another row carries the same word, which
  // a whole-docblock substring check cannot see (`string` also documents retainedOutput).
  assert.deepEqual(schemaRowDrift(table.map((row) => (row.field === "command" ? { ...row, shape: "string" } : row)), documented),
    ["command shape"]);
  // A field renamed in the data copy or in the docblock is drift too.
  assert.notDeepEqual(schemaRowDrift(table.map((row) => (row.field === "command" ? { ...row, field: "argv" } : row)), documented), []);
  const renamedDocblock = new Map([...documented].map(([field, row]) => [field === "command" ? "argv" : field, row]));
  assert.notDeepEqual(schemaRowDrift(table, renamedDocblock), []);
  for (const row of table) {
    assert.match(row.pointer, /^(\/[A-Za-z_]+)+$/);
    assert.equal(typeof row.shape, "string");
  }
  // One vocabulary only: the former internal tokens disagree with the documented table.
  for (const token of ["uuidv7", "opaque_string", "iso_timestamp", "terminal_status", "file_uri", "string_array"]) {
    assert.ok(!table.some((row) => row.shape === token), `SCHEMA must not publish the internal token ${token}`);
  }
  assert.deepEqual([...CODEX_TERMINAL_STATUSES].sort(), ["completed", "failed"]);
});

test("the three typed statuses are exactly completed, unknown and unsupported", () => {
  assert.deepEqual(Object.values(EVIDENCE_STATUSES).sort(), ["completed", "unknown", "unsupported"]);
});

test("an incomplete request is typed unknown rather than a guess", () => {
  assertUnknown(reconcile(writeJournal([commandExecution()]), { ownerThreadId: undefined }), EVIDENCE_REASONS.INVALID_REQUEST);
  assertUnknown(reconcile(writeJournal([commandExecution()]), { executionId: "   " }), EVIDENCE_REASONS.INVALID_REQUEST);
  assertUnknown(reconcile(writeJournal([commandExecution()]), { repoRoot: undefined }), EVIDENCE_REASONS.INVALID_REQUEST);
  assertUnknown(reconcile(writeJournal([commandExecution()]), { cwd: undefined }), EVIDENCE_REASONS.INVALID_REQUEST);
});

test("a non-absolute repository root or working directory is a malformed request", () => {
  const file = writeJournal([commandExecution()]);
  // Accepted: absolute values bind normally, so rejection below is about the value class.
  assert.equal(reconcile(file).status, EVIDENCE_STATUSES.COMPLETED);
  assertUnknown(reconcile(file, { repoRoot: "/work/other-repo", cwd: WORKTREE }), EVIDENCE_REASONS.REPOSITORY_ROOT_MISMATCH);
  // Rejected: a relative or home-prefixed path is never resolved against this process.
  for (const overrides of [
    { repoRoot: "tmp/worktrees/dev-loops/issue-2886" },
    { cwd: "./tmp/worktrees/dev-loops/issue-2878" },
    { repoRoot: "~/repo" },
  ]) {
    assertUnknown(reconcile(file, overrides), EVIDENCE_REASONS.INVALID_REQUEST);
  }
});

test("a padded execution id is a malformed request, not an execution mismatch", () => {
  const file = writeJournal([commandExecution()]);
  // One rule: the id is compared exactly, so padding is rejected rather than silently
  // normalized, and it never surfaces as the wrong-owner-style mismatch class.
  assertUnknown(reconcile(file, { executionId: " 12938" }), EVIDENCE_REASONS.INVALID_REQUEST);
  assertUnknown(reconcile(file, { executionId: "12938 " }), EVIDENCE_REASONS.INVALID_REQUEST);
  assert.equal(reconcile(file, { executionId: EXECUTION }).status, EVIDENCE_STATUSES.COMPLETED);
});

after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});
