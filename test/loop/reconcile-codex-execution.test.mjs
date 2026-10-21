import assert from "node:assert/strict";
import { afterAll as after, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  main,
  parseReconcileArgs,
} from "../../scripts/loop/reconcile-codex-execution.mjs";

const OWNER = "01a15929-c860-7690-86d8-50f51506a786";
const OTHER_OWNER = "01a15929-c860-7690-86d8-50f51506a787";
const EXECUTION = "12938";
const RETAINED = "bun test: 0 pass, 0 skip, 24 fail across 1 file (127.36s)";
const CONTRACT = fs.readFileSync(new URL("../../skills/docs/main-agent-contract.md", import.meta.url), "utf8");

const tempRoots = [];
function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-codex-"));
  tempRoots.push(root);
  const repoRoot = path.join(root, "repo");
  const cwd = path.join(repoRoot, "tmp", "worktrees", "dev-loops", "issue-2878");
  const codexHome = path.join(root, ".codex");
  const sessionDir = path.join(codexHome, "sessions", "2026", "10", "20");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const journalPath = path.join(sessionDir, `rollout-2026-10-20T13-54-33-${OWNER}.jsonl`);
  const env = { CODEX_HOME: codexHome, CODEX_THREAD_ID: OWNER, DEVLOOPS_RECONCILE_FIXTURE: "1" };
  return { root, repoRoot, cwd, codexHome, sessionDir, journalPath, env };
}

function header(id = OWNER) {
  return { timestamp: "2026-10-20T11:54:33.187Z", ordinal: 0, type: "session_meta", payload: { id } };
}

function terminalRecord({ cwdUri }) {
  return {
    timestamp: "2026-10-20T11:59:37.885Z",
    ordinal: 185,
    type: "event_msg",
    payload: {
      type: "item_completed",
      thread_id: OWNER,
      item: {
        type: "CommandExecution",
        id: "exec-a18f4b73-f369-4841-9a64-261d9fff244e",
        process_id: EXECUTION,
        command: ["/bin/zsh", "-lc", "bun scripts/run-bun-test.mjs test/loop/example.test.mjs"],
        cwd: cwdUri,
        status: "failed",
        aggregated_output: RETAINED,
        exit_code: 1,
      },
    },
  };
}

function writeJournal(workspace, { terminal = terminalRecord({ cwdUri: `file://${workspace.cwd}` }) } = {}) {
  fs.writeFileSync(workspace.journalPath, `${[header(), terminal].map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function baseArgs(workspace) {
  return [
    "--repo-root", workspace.repoRoot,
    "--owner-thread-id", OWNER,
    "--execution-id", EXECUTION,
    "--cwd", workspace.cwd,
    "--journal", workspace.journalPath,
    "--json",
  ];
}

function capture() {
  return { data: "", write(chunk) { this.data += chunk; return true; } };
}

function run(argv, env) {
  const stdout = capture();
  const stderr = capture();
  const code = main(argv, { env, stdout, stderr });
  return { code, stdout: stdout.data, stderr: stderr.data, json: stdout.data.trim() ? JSON.parse(stdout.data) : null };
}

after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

test("CLI: completed reconciliation exits 0 and preserves recorded terminal evidence", () => {
  const workspace = makeWorkspace();
  writeJournal(workspace);
  const result = run(baseArgs(workspace), workspace.env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.status, "completed");
  assert.equal(result.json.reason, "terminal_evidence_verified");
  assert.equal(result.json.owner.threadId, OWNER);
  assert.equal(result.json.execution.exitCode, 1);
  assert.equal(result.json.execution.output.text, RETAINED);
  assert.deepEqual(result.json.cleanup, { blocker: false, processProbeAllowed: false });
});

test("CLI: missing terminal evidence is a typed unknown that still exits 0", () => {
  const workspace = makeWorkspace();
  fs.writeFileSync(workspace.journalPath, `${JSON.stringify(header())}\n`);
  const result = run(baseArgs(workspace), workspace.env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.status, "unknown");
  assert.equal(result.json.reason, "no_terminal_result");
  assert.deepEqual(result.json.cleanup, { blocker: "unknown", processProbeAllowed: false });
});

test("CLI: unsupported is a typed result that still exits 0", () => {
  const workspace = makeWorkspace();
  const stdout = capture();
  const stderr = capture();
  const code = main(baseArgs(workspace), {
    env: workspace.env,
    stdout,
    stderr,
    resolve: () => ({
      ok: true,
      status: "unsupported",
      reason: "unsupported_runtime_capability",
      owner: { threadId: OWNER },
      execution: null,
      cleanup: { blocker: "unknown", processProbeAllowed: false },
    }),
  });
  assert.equal(code, 0, stderr.data);
  assert.equal(JSON.parse(stdout.data).status, "unsupported");
  assert.equal(JSON.parse(stdout.data).reason, "unsupported_runtime_capability");
  assert.deepEqual(JSON.parse(stdout.data).cleanup, { blocker: "unknown", processProbeAllowed: false });
});

test("CLI: malformed arguments exit 2 with a JSON error and usage", () => {
  const workspace = makeWorkspace();
  const required = (owner = OWNER, execution = EXECUTION) => [
    "--repo-root", workspace.repoRoot,
    "--owner-thread-id", owner,
    "--execution-id", execution,
    "--cwd", workspace.cwd,
  ];
  const cases = [
    ["unknown flag", ["--nope"]],
    ["missing required flag", ["--repo-root", workspace.repoRoot]],
    ["non-UUIDv7 owner", required("not-a-uuid")],
    ["blank execution id", required(OWNER, "   ")],
    ["pid-shaped option", [...required(), "--pid", "12938"]],
    ["kill-shaped option", [...required(), "--kill=12938"]],
    ["duplicate value flag", [...required(), "--cwd", workspace.cwd]],
    ["blank journal", [...required(), "--journal", "   "]],
  ];
  for (const [name, argv] of cases) {
    const result = run(argv, workspace.env);
    assert.equal(result.code, 2, name);
    const error = JSON.parse(result.stderr.split("\n")[0]);
    assert.equal(error.ok, false, name);
    assert.match(result.stderr, /Usage: reconcile-codex-execution\.mjs/, name);
  }
  assert.throws(() => parseReconcileArgs(["--pid", "1"]), /unrecognized flag/);
});

test("CLI: -h and -s short aliases are honored", () => {
  const workspace = makeWorkspace();
  writeJournal(workspace);
  const helpOut = capture();
  const helpErr = capture();
  assert.equal(main(["-h"], { env: workspace.env, stdout: helpOut, stderr: helpErr }), 0);
  assert.match(helpOut.data, /Usage: reconcile-codex-execution\.mjs/);
  const silent = run([...baseArgs(workspace), "-s"], workspace.env);
  assert.equal(silent.code, 0);
  assert.equal(silent.stdout, "");
});

test("CLI: --journal is refused outside the test/fixture role", () => {
  const workspace = makeWorkspace();
  writeJournal(workspace);
  const productionEnv = { ...workspace.env };
  delete productionEnv.DEVLOOPS_RECONCILE_FIXTURE;
  const refused = run(baseArgs(workspace), productionEnv);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /journal is only available in the test\/fixture role/);
  const allowed = run(baseArgs(workspace), workspace.env);
  assert.equal(allowed.code, 0, allowed.stderr);
});

test("CLI: unreadable or ambiguous owner journal exits 1 with the precise reason", () => {
  const workspace = makeWorkspace();
  writeJournal(workspace);
  const missing = run(baseArgs(workspace).slice(0, -3).concat("--journal", path.join(workspace.root, "missing.jsonl"), "--json"), workspace.env);
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stderr).ok, false);
  assert.match(missing.stderr, /owner_journal/);

  // Discovery-based ambiguity: two journals want the same owner thread.
  fs.copyFileSync(workspace.journalPath, path.join(workspace.sessionDir, `rollout-duplicate-${OWNER}.jsonl`));
  const noJournal = [
    "--repo-root", workspace.repoRoot,
    "--owner-thread-id", OWNER,
    "--execution-id", EXECUTION,
    "--cwd", workspace.cwd,
  ];
  const ambiguous = run(noJournal, workspace.env);
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.stderr, /ambiguous/i);

  // A mismatched header fails closed instead of trusting the caller-supplied path.
  fs.writeFileSync(workspace.journalPath, `${JSON.stringify(header(OTHER_OWNER))}\n`);
  const mismatch = run(baseArgs(workspace), workspace.env);
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.stderr, /owner_journal_mismatch/);
});

test("contract: reconciliation precedes any cleanup-blocker decision and the schema table is mirrored", () => {
  assert.match(CONTRACT, /Terminal reconciliation MUST run before any process-inspection or cleanup escalation/);
  assert.match(CONTRACT, /unavailable handle is never evidence of a live process/);
  for (const pointer of [
    "/type",
    "/payload/type",
    "/payload/item/type",
    "/payload/thread_id",
    "/payload/item/process_id",
    "/payload/item/id",
    "/timestamp",
    "/payload/item/status",
    "/payload/item/exit_code",
    "/payload/item/command",
    "/payload/item/cwd",
    "/payload/item/aggregated_output",
    "/payload/completed_at_ms",
    "/payload/started_at_ms",
    "/payload/id on /type = session_meta",
  ]) {
    assert.ok(CONTRACT.includes(pointer), `contract is missing mirrored schema pointer ${pointer}`);
  }
  // The requirement is scoped under the Codex active-join surface, not Pi/Claude prose.
  const codexSection = CONTRACT.slice(CONTRACT.indexOf("## Codex active joins"), CONTRACT.indexOf("## Contract"));
  assert.match(codexSection, /Terminal reconciliation MUST run before any process-inspection or cleanup escalation/);
});
