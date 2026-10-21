import assert from "node:assert/strict";
import { afterAll as after, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CODEX_EXECUTION_EVIDENCE_SCHEMA,
  cleanupDisposition,
  resolveCodexExecutionEvidence,
  unsupportedRuntimeResult,
  validateCodexJournalOwner,
} from "../src/loop/codex-execution-evidence.mjs";

const OWNER = "01a15929-c860-7690-86d8-50f51506a786";
const EXECUTION = "12938";
const WORKER_STOP = "2026-10-20T11:58:44.999Z";
const TERMINAL = "2026-10-20T11:59:37.885Z";
const COMMAND = ["/bin/zsh", "-lc", "bun scripts/run-bun-test.mjs test/loop/example.test.mjs --timeout 30000"];
const RETAINED = "bun test: 0 pass, 0 skip, 24 fail across 1 file (127.36s)";
const SOURCE = fs.readFileSync(new URL("../src/loop/codex-execution-evidence.mjs", import.meta.url), "utf8");

const tempRoots = [];
function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-evidence-"));
  tempRoots.push(root);
  const repoRoot = path.join(root, "repo");
  const cwd = path.join(repoRoot, "tmp", "worktrees", "dev-loops", "issue-2878");
  const sessionDir = path.join(root, ".codex", "sessions", "2026", "10", "20");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const journalPath = path.join(sessionDir, `rollout-2026-10-20T13-54-33-${OWNER}.jsonl`);
  const env = { CODEX_HOME: path.join(root, ".codex"), CODEX_THREAD_ID: OWNER, DEVLOOPS_RECONCILE_FIXTURE: "1" };
  return { root, repoRoot, cwd, sessionDir, journalPath, env };
}

function header(overrides = {}) {
  return {
    timestamp: "2026-10-20T11:54:33.187Z",
    ordinal: 0,
    type: "session_meta",
    payload: {
      id: OWNER,
      parent_thread_id: "01a15922-5286-7900-b26d-ca2fe181cb85",
      cwd: "/Users/mfittko/github/dev-loops",
      runtime_workspace_roots: ["/Users/mfittko/github/dev-loops"],
      ...overrides,
    },
  };
}

function workerStop() {
  return {
    timestamp: WORKER_STOP,
    ordinal: 184,
    type: "event_msg",
    payload: { type: "task_complete", thread_id: OWNER, last_agent_message: "Stopped on native permission denial" },
  };
}

function terminalRecord({ payload = {}, item = {}, timestamp = TERMINAL } = {}) {
  return {
    timestamp,
    ordinal: 185,
    type: "event_msg",
    payload: {
      type: "item_completed",
      thread_id: OWNER,
      turn_id: "01a15929-c8f8-7922-8edf-06747fcdef2c",
      item: {
        type: "CommandExecution",
        id: "exec-a18f4b73-f369-4841-9a64-261d9fff244e",
        process_id: EXECUTION,
        command: COMMAND,
        cwd: "file:///PLACEHOLDER",
        status: "failed",
        aggregated_output: RETAINED,
        exit_code: 1,
        ...item,
      },
      started_at_ms: 1792497450581,
      completed_at_ms: 1792497577885,
      ...payload,
    },
  };
}

function writeJournal(workspace, records) {
  fs.writeFileSync(workspace.journalPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function journalWith(workspace, terminal = terminalRecord()) {
  const record = structuredClone(terminal);
  record.payload.item.cwd = `file://${workspace.cwd}`;
  writeJournal(workspace, [header(), workerStop(), record]);
  return record;
}

function reconcile(workspace, overrides = {}) {
  return resolveCodexExecutionEvidence({
    ownerThreadId: OWNER,
    executionId: EXECUTION,
    repoRoot: workspace.repoRoot,
    cwd: workspace.cwd,
    journalPath: workspace.journalPath,
    env: workspace.env,
    fs,
    ...overrides,
  });
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

test("C1/C2: worker exit followed by a later terminal record reconciles as completed without rewriting the journal", () => {
  const workspace = makeWorkspace();
  journalWith(workspace);
  const before = sha256(workspace.journalPath);
  const result = reconcile(workspace);
  assert.equal(result.ok, true);
  assert.equal(result.status, "completed");
  assert.equal(result.reason, "terminal_evidence_verified");
  // The terminal event is 52.886s after the worker stopped; ordering is preserved, not rewritten.
  assert.equal(result.execution.timestamp, TERMINAL);
  assert.equal(Date.parse(TERMINAL) > Date.parse(WORKER_STOP), true);
  assert.equal(result.execution.status, "failed");
  assert.equal(result.execution.exitCode, 1);
  assert.deepEqual(result.execution.command, COMMAND);
  assert.equal(result.execution.cwd, fs.realpathSync(workspace.cwd));
  assert.equal(result.execution.output.text, RETAINED);
  assert.equal(result.execution.output.bytes, Buffer.byteLength(RETAINED, "utf8"));
  assert.equal(result.execution.nativeId, "exec-a18f4b73-f369-4841-9a64-261d9fff244e");
  assert.deepEqual(result.cleanup, { blocker: false, processProbeAllowed: false });
  assert.equal(sha256(workspace.journalPath), before);
});

test("C2: discovery resolves the same single journal the header-only identity reader uses", () => {
  const workspace = makeWorkspace();
  journalWith(workspace);
  const result = reconcile(workspace, { journalPath: undefined });
  assert.equal(result.status, "completed");
  assert.equal(result.execution.id, EXECUTION);
});

test("C2: every unbound or ambiguous evidence class stays typed unknown", () => {
  const cases = [
    {
      name: "wrong owner thread",
      prepare: (workspace) => journalWith(workspace, terminalRecord({ payload: { thread_id: "01a15929-c860-7690-86d8-50f51506a787" } })),
      range: {},
      reason: "wrong_owner_thread",
    },
    {
      name: "wrong execution id",
      prepare: (workspace) => journalWith(workspace),
      range: { executionId: "99999" },
      reason: "wrong_execution_id",
    },
    {
      name: "wrong cwd",
      prepare: (workspace) => {
        journalWith(workspace);
        const other = path.join(workspace.repoRoot, "elsewhere");
        fs.mkdirSync(other, { recursive: true });
        return other;
      },
      range: (workspace, other) => ({ cwd: other }),
      reason: "wrong_cwd",
    },
    {
      name: "wrong repository root",
      prepare: (workspace) => journalWith(workspace),
      range: { repoRoot: path.join(os.tmpdir(), "not-the-repo") },
      reason: "wrong_repository",
    },
    {
      name: "missing terminal record",
      prepare: (workspace) => writeJournal(workspace, [header(), workerStop()]),
      range: {},
      reason: "no_terminal_result",
    },
    {
      name: "malformed record",
      prepare: (workspace) => {
        writeJournal(workspace, [header(), workerStop()]);
        fs.appendFileSync(workspace.journalPath, "{not json\n");
      },
      range: {},
      reason: "malformed_record",
    },
    {
      name: "schema drift on a disclosed path",
      prepare: (workspace) => journalWith(workspace, terminalRecord({ item: { exit_code: undefined, exitCode: 1 } })),
      range: {},
      reason: "schema_drift",
    },
    {
      name: "conflicting terminal records",
      prepare: (workspace) => {
        const first = terminalRecord();
        const second = terminalRecord({ item: { id: "exec-other", exit_code: 0, status: "succeeded" } });
        first.payload.item.cwd = `file://${workspace.cwd}`;
        second.payload.item.cwd = `file://${workspace.cwd}`;
        writeJournal(workspace, [header(), workerStop(), first, second]);
      },
      range: {},
      reason: "conflicting_terminal_records",
    },
  ];

  for (const testCase of cases) {
    const workspace = makeWorkspace();
    const extra = testCase.prepare(workspace);
    const overrides = typeof testCase.range === "function" ? testCase.range(workspace, extra) : testCase.range;
    let probed = 0;
    const result = reconcile(workspace, {
      processProbe: () => { probed += 1; },
      ...overrides,
    });
    assert.equal(result.ok, true, testCase.name);
    assert.equal(result.status, "unknown", testCase.name);
    assert.equal(result.reason, testCase.reason, testCase.name);
    assert.equal(result.execution, null, testCase.name);
    assert.deepEqual(result.cleanup, { blocker: "unknown", processProbeAllowed: false }, testCase.name);
    assert.equal(probed, 0, `${testCase.name}: reconciliation must never probe a process`);
  }
});

test("C2: owner journal binding fails closed for a mismatched header or unreadable path", () => {
  const workspace = makeWorkspace();
  journalWith(workspace);
  assert.deepEqual(validateCodexJournalOwner(header(), OWNER), { ok: true });
  assert.equal(validateCodexJournalOwner(header({ id: "01a15929-c860-7690-86d8-50f51506a787" }), OWNER).reason, "owner_journal_mismatch");
  const mismatch = reconcile(workspace, { ownerThreadId: "01a15929-c860-7690-86d8-50f51506a787" });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "owner_journal_mismatch");
  assert.equal(reconcile(workspace, { journalPath: path.join(workspace.root, "missing.jsonl") }).ok, false);
  // An explicit path is a fixture capability; the public adapter refuses it in production mode.
  const noFixtureRole = reconcile(workspace, { env: { CODEX_HOME: workspace.env.CODEX_HOME, CODEX_THREAD_ID: OWNER } });
  assert.equal(noFixtureRole.ok, false);
  assert.equal(noFixtureRole.reason, "journal_path_outside_fixture_role");
  // Discovery (no explicit path) still works without the fixture role.
  const discovered = reconcile(workspace, { journalPath: undefined, env: { CODEX_HOME: workspace.env.CODEX_HOME, CODEX_THREAD_ID: OWNER } });
  assert.equal(discovered.status, "completed");
});

test("C3: only completed clears the cleanup blocker and no status authorizes process probing", () => {
  for (const [status, expected] of [
    ["completed", { blocker: false, processProbeAllowed: false }],
    ["unknown", { blocker: "unknown", processProbeAllowed: false }],
    ["unsupported", { blocker: "unknown", processProbeAllowed: false }],
  ]) {
    let probed = 0;
    assert.deepEqual(cleanupDisposition(status, { processProbe: () => { probed += 1; } }), expected);
    assert.equal(probed, 0);
  }
  const unsupported = unsupportedRuntimeResult({ ownerThreadId: OWNER });
  assert.equal(unsupported.status, "unsupported");
  assert.equal(unsupported.reason, "unsupported_runtime_capability");
  assert.deepEqual(unsupported.cleanup, { blocker: "unknown", processProbeAllowed: false });
});

test("C3: the adapter imports no process/spawn/kill API and a numeric session id stays opaque", () => {
  assert.doesNotMatch(SOURCE, /node:child_process/);
  assert.doesNotMatch(SOURCE, /\bprocess\.kill\s*\(/);
  assert.doesNotMatch(SOURCE, /\bspawn(?:Sync)?\s*\(/);
  assert.doesNotMatch(SOURCE, /\bexec(?:File)?(?:Sync)?\s*\(/);
  assert.doesNotMatch(SOURCE, /\bkill\s*\(/);

  const workspace = makeWorkspace();
  journalWith(workspace);
  const result = reconcile(workspace);
  assert.equal(typeof result.execution.id, "string");
  assert.equal(result.execution.id, "12938");
  assert.doesNotMatch(JSON.stringify(result), /"(?:pid|processId|killTarget)"\s*:/);
});

test("schema disclosure lists the exact JSON pointer paths read", () => {
  const pointers = CODEX_EXECUTION_EVIDENCE_SCHEMA.map((entry) => entry.pointer);
  for (const expected of [
    "/type", "/payload/type", "/payload/item/type", "/payload/thread_id",
    "/payload/item/process_id", "/payload/item/id", "/timestamp", "/payload/item/status",
    "/payload/item/exit_code", "/payload/item/command", "/payload/item/cwd",
    "/payload/item/aggregated_output", "/payload/completed_at_ms", "/payload/started_at_ms",
    "/payload/id on /type = session_meta",
  ]) {
    assert.ok(pointers.includes(expected), `missing disclosed pointer ${expected}`);
  }
});
