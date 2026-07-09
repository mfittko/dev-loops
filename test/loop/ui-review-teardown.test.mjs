import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { teardown, ROW_STATUS, WORKTREE_STATUS, PROCESS_STATUS } from "@dev-loops/core/loop/ui-review-teardown";
import { parseUiReviewTeardownCliArgs, killProcess, runCli } from "../../scripts/loop/ui-review-teardown.mjs";

// A Stage-1 provision result: a booted app (pid), applied migrations, a worktree.
const PROVISION = {
  ok: true,
  worktreePath: "/repo/tmp/worktrees/dev-loops/pr-7",
  migrations: { pending: 2, applied: 2, destructive: [], detail: "2 applied" },
  boot: { pid: 4242, ready: true },
};

// A Stage-2 drive result that DID drive mutating steps (rows may have been made).
const DRIVE_WITH_STEPS = { ok: true, stopped: false, steps: [{ flow: "users", step: "create", ok: true }] };
// A drive that stopped before driving anything (auth failed) — created nothing.
const DRIVE_STOPPED = { ok: false, stopped: true, steps: [] };

// Recording seams: every destructive seam logs whether it was called, so a test
// can assert the confirmation gate actually blocked (not merely no-op'd) a step.
function makeSeams(overrides = {}) {
  const calls = { kill: 0, drop: 0, removeWorktree: 0 };
  const seams = {
    killProcess: async () => {
      calls.kill += 1;
      return { stopped: true, forced: false, detail: "stopped via SIGTERM" };
    },
    dropRows: async ({ rows }) => {
      calls.drop += 1;
      return { ok: true, dropped: rows.length, detail: "dropped" };
    },
    removeWorktree: async () => {
      calls.removeWorktree += 1;
      return { removed: "/repo/tmp/worktrees/dev-loops/pr-7", ok: true, detail: "removed" };
    },
    log: () => {},
    ...overrides,
  };
  return { seams, calls };
}

test("teardown always emits a ledger enumerating every known side effect (confirmed success)", async () => {
  const { seams, calls } = makeSeams();
  const res = await teardown(
    { provisionResult: PROVISION, driveResult: DRIVE_WITH_STEPS, rowManifest: [{ table: "users", id: 1 }], confirm: true },
    seams,
  );

  assert.equal(res.ok, true);
  assert.equal(res.confirmed, true);
  // Ledger enumerates ALL four side-effect categories.
  assert.ok(res.ledger.migrations, "migrations enumerated");
  assert.ok(res.ledger.rows, "rows enumerated");
  assert.ok(res.ledger.worktree, "worktree enumerated");
  assert.ok(res.ledger.process, "process enumerated");
  // Migrations recorded as applied-not-reverted (non-goal: no rollback).
  assert.equal(res.ledger.migrations.applied, 2);
  assert.equal(res.ledger.migrations.reverted, false);
  // Destructive steps ran (confirmed): app stopped, rows dropped, worktree removed.
  assert.equal(res.ledger.process.status, PROCESS_STATUS.STOPPED);
  assert.equal(res.ledger.rows.status, ROW_STATUS.DROPPED);
  assert.equal(res.ledger.rows.dropped, 1);
  assert.equal(res.ledger.worktree.status, WORKTREE_STATUS.REMOVED);
  assert.equal(res.ledger.worktree.path, PROVISION.worktreePath);
  assert.deepEqual(calls, { kill: 1, drop: 1, removeWorktree: 1 });
});

test("confirmation gate blocks destructive steps (no --confirm): app stops, row-drop + worktree-removal do NOT run, ledger still emitted", async () => {
  const { seams, calls } = makeSeams();
  const res = await teardown(
    { provisionResult: PROVISION, driveResult: DRIVE_WITH_STEPS, rowManifest: [{ table: "users", id: 1 }], confirm: false },
    seams,
  );

  // The ledger is STILL emitted in full.
  assert.ok(res.ledger.migrations && res.ledger.rows && res.ledger.worktree && res.ledger.process);
  assert.equal(res.confirmed, false);
  // App stop is a clean shutdown — NOT gated on confirmation — so it ran.
  assert.equal(calls.kill, 1);
  assert.equal(res.ledger.process.status, PROCESS_STATUS.STOPPED);
  // Destructive steps were BLOCKED — the seams were never called.
  assert.equal(calls.drop, 0, "row drop must not run without confirmation");
  assert.equal(calls.removeWorktree, 0, "worktree removal must not run without confirmation");
  assert.equal(res.ledger.rows.status, ROW_STATUS.SKIPPED_UNCONFIRMED);
  assert.equal(res.ledger.worktree.status, WORKTREE_STATUS.SKIPPED_UNCONFIRMED);
  assert.equal(res.ledger.worktree.removed, false);
  // No confirmation is not a failure.
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
});

test("untagged rows: confirmed drive with no manifest reports 'rows may remain (untagged)', never guesses", async () => {
  const { seams, calls } = makeSeams();
  const res = await teardown(
    { provisionResult: PROVISION, driveResult: DRIVE_WITH_STEPS, rowManifest: null, confirm: true },
    seams,
  );
  assert.equal(res.ledger.rows.status, ROW_STATUS.MAY_REMAIN_UNTAGGED);
  assert.match(res.ledger.rows.detail, /may remain \(untagged\)/i);
  assert.equal(calls.drop, 0, "must not guess-drop untagged rows");
  // Not a teardown failure — the honest expected state.
  assert.equal(res.ok, true);
});

test("no rows created: a drive that stopped before driving reports 'none'", async () => {
  const { seams } = makeSeams();
  const res = await teardown(
    { provisionResult: PROVISION, driveResult: DRIVE_STOPPED, confirm: true },
    seams,
  );
  assert.equal(res.ledger.rows.status, ROW_STATUS.NONE);
});

test("null PID: ledger reports the process may still be running (no blind kill)", async () => {
  const { seams, calls } = makeSeams();
  const provisionNoPid = { ...PROVISION, boot: { pid: null, ready: true } };
  const res = await teardown({ provisionResult: provisionNoPid, confirm: true }, seams);
  assert.equal(calls.kill, 0, "no PID => never call kill");
  assert.equal(res.ledger.process.status, PROCESS_STATUS.MAY_BE_RUNNING);
  assert.equal(res.ledger.process.pid, null);
});

test("failed kill is reported, not swallowed", async () => {
  const { seams } = makeSeams({
    killProcess: async () => ({ stopped: false, forced: true, detail: "process still alive after SIGKILL" }),
  });
  const res = await teardown({ provisionResult: PROVISION, confirm: true }, seams);
  assert.equal(res.ok, false, "a failed kill fails the teardown result");
  assert.equal(res.ledger.process.status, PROCESS_STATUS.KILL_FAILED);
  assert.ok(res.errors.some((e) => /app stop FAILED/.test(e)), "kill failure surfaced in errors");
});

test("force-kill (SIGKILL fallback) is recorded in the ledger", async () => {
  const { seams } = makeSeams({
    killProcess: async () => ({ stopped: true, forced: true, detail: "force-killed after grace" }),
  });
  const res = await teardown({ provisionResult: PROVISION, confirm: true }, seams);
  assert.equal(res.ledger.process.status, PROCESS_STATUS.STOPPED);
  assert.equal(res.ledger.process.forced, true);
});

test("failed row drop (confirmed manifest) is reported, not swallowed", async () => {
  const { seams } = makeSeams({
    dropRows: async () => ({ ok: false, dropped: 0, detail: "db connection refused" }),
  });
  const res = await teardown(
    { provisionResult: PROVISION, driveResult: DRIVE_WITH_STEPS, rowManifest: [{ id: 1 }], confirm: true },
    seams,
  );
  assert.equal(res.ok, false);
  assert.equal(res.ledger.rows.status, ROW_STATUS.DROP_FAILED);
  assert.ok(res.errors.some((e) => /row drop FAILED/.test(e)));
});

test("failed worktree removal (confirmed) is reported, not swallowed", async () => {
  const { seams } = makeSeams({
    removeWorktree: async () => ({ removed: null, ok: false, detail: "refused: not under namespace" }),
  });
  const res = await teardown({ provisionResult: PROVISION, confirm: true }, seams);
  assert.equal(res.ok, false);
  assert.equal(res.ledger.worktree.status, WORKTREE_STATUS.REMOVE_FAILED);
  assert.ok(res.errors.some((e) => /worktree removal FAILED/.test(e)));
});

test("--no-stop-app path leaves the process untouched but still enumerates it", async () => {
  const { seams, calls } = makeSeams();
  const res = await teardown({ provisionResult: PROVISION, stopApp: false, confirm: true }, seams);
  assert.equal(calls.kill, 0);
  assert.equal(res.ledger.process.status, PROCESS_STATUS.SKIPPED);
  assert.equal(res.ledger.process.pid, 4242);
});

// Fix 1: a PID that is not a positive integer must NEVER reach the kill seam.
// The CLI's group-kill would signal `process.kill(0)` (this loop's OWN group)
// for pid 0 or `process.kill(-1)` (every process) for pid -1.
for (const badPid of [0, -1, NaN, 3.5, "4242", {}]) {
  test(`non-positive/non-integer PID (${String(badPid)}) never reaches the kill seam; ledger reports may-be-running`, async () => {
    const { seams, calls } = makeSeams();
    const provisionBadPid = { ...PROVISION, boot: { pid: badPid, ready: true } };
    const res = await teardown({ provisionResult: provisionBadPid, confirm: true }, seams);
    assert.equal(calls.kill, 0, "unusable PID => never call kill");
    assert.equal(res.ledger.process.status, PROCESS_STATUS.MAY_BE_RUNNING);
    assert.equal(res.ledger.process.pid, null, "unusable PID is nulled in the ledger");
    assert.match(res.ledger.process.detail, /may still be running/i);
  });
}

// Fix 2: the always-emit-ledger invariant must survive a seam that THROWS.
test("a throwing kill seam still yields a fully-emitted ledger (KILL_FAILED, ok:false)", async () => {
  const { seams } = makeSeams({
    killProcess: async () => { throw new Error("kill seam boom"); },
  });
  const res = await teardown({ provisionResult: PROVISION, confirm: true }, seams);
  assert.equal(res.ok, false);
  assert.equal(res.ledger.process.status, PROCESS_STATUS.KILL_FAILED);
  // Ledger is STILL emitted in full despite the throw.
  assert.ok(res.ledger.migrations && res.ledger.rows && res.ledger.worktree && res.ledger.process);
  assert.ok(res.errors.some((e) => /kill seam threw/.test(e)));
});

test("a throwing removeWorktree seam still yields a fully-emitted ledger (REMOVE_FAILED, ok:false)", async () => {
  const { seams } = makeSeams({
    removeWorktree: async () => { throw new Error("rm seam boom"); },
  });
  const res = await teardown({ provisionResult: PROVISION, confirm: true }, seams);
  assert.equal(res.ok, false);
  assert.equal(res.ledger.worktree.status, WORKTREE_STATUS.REMOVE_FAILED);
  assert.ok(res.ledger.migrations && res.ledger.rows && res.ledger.worktree && res.ledger.process);
  assert.ok(res.errors.some((e) => /removeWorktree seam threw/.test(e)));
});

test("a throwing dropRows seam still yields a fully-emitted ledger (DROP_FAILED, ok:false)", async () => {
  const { seams } = makeSeams({
    dropRows: async () => { throw new Error("drop seam boom"); },
  });
  const res = await teardown(
    { provisionResult: PROVISION, driveResult: DRIVE_WITH_STEPS, rowManifest: [{ id: 1 }], confirm: true },
    seams,
  );
  assert.equal(res.ok, false);
  assert.equal(res.ledger.rows.status, ROW_STATUS.DROP_FAILED);
  assert.ok(res.ledger.migrations && res.ledger.rows && res.ledger.worktree && res.ledger.process);
  assert.ok(res.errors.some((e) => /drop seam threw/.test(e)));
});

// Fix 2: a non-string worktreePath must not throw (path.resolve would); it is
// recorded as a malformed-path failure and the removeWorktree seam is not called.
test("malformed (non-string) worktreePath fails closed, never reaches removeWorktree, ledger still emitted", async () => {
  const { seams, calls } = makeSeams();
  const provisionBadPath = { ...PROVISION, worktreePath: { not: "a string" } };
  const res = await teardown({ provisionResult: provisionBadPath, confirm: true }, seams);
  assert.equal(calls.removeWorktree, 0, "malformed path must not reach the removal seam");
  assert.equal(res.ledger.worktree.status, WORKTREE_STATUS.REMOVE_FAILED);
  assert.match(res.ledger.worktree.detail, /malformed worktree path/i);
  assert.equal(res.ok, false);
});

// Fix 3(a): unconfirmed drive-with-steps and no manifest => rows may remain.
test("confirm:false + drive-with-steps + no manifest => MAY_REMAIN_UNTAGGED, drop seam not called", async () => {
  const { seams, calls } = makeSeams();
  const res = await teardown(
    { provisionResult: PROVISION, driveResult: DRIVE_WITH_STEPS, rowManifest: null, confirm: false },
    seams,
  );
  assert.equal(res.ledger.rows.status, ROW_STATUS.MAY_REMAIN_UNTAGGED);
  assert.equal(calls.drop, 0);
  assert.equal(res.ok, true);
});

// Fix 3(b): unconfirmed stopped-drive (no rows) => NONE.
test("confirm:false + stopped drive (no rows) => ROW_STATUS.NONE", async () => {
  const { seams, calls } = makeSeams();
  const res = await teardown(
    { provisionResult: PROVISION, driveResult: DRIVE_STOPPED, confirm: false },
    seams,
  );
  assert.equal(res.ledger.rows.status, ROW_STATUS.NONE);
  assert.equal(calls.drop, 0);
});

// Fix 3(c): provision without worktreePath => distinct MISSING_PATH status (NOT
// conflated with SKIPPED_UNCONFIRMED — the ledger must say WHY removal did not
// run: a missing path, not a withheld confirmation). Holds even with confirm:true.
test("provision without worktreePath => MISSING_PATH (distinct from unconfirmed-skip), removeWorktree not called", async () => {
  const { seams, calls } = makeSeams();
  const provisionNoWorktree = { ...PROVISION, worktreePath: undefined };
  const res = await teardown({ provisionResult: provisionNoWorktree, confirm: true }, seams);
  assert.equal(res.ledger.worktree.status, WORKTREE_STATUS.MISSING_PATH);
  assert.notEqual(res.ledger.worktree.status, WORKTREE_STATUS.SKIPPED_UNCONFIRMED);
  assert.match(res.ledger.worktree.detail, /no worktree path/i);
  assert.equal(res.ledger.worktree.path, null);
  assert.equal(calls.removeWorktree, 0);
});

// Folded defer: real killProcess against a spawned child process. Each child
// prints "ready" AFTER its handlers are installed; the test waits for that line
// to avoid a startup race where a signal arrives before the child is set up.
function spawnReadyChild(script) {
  const child = spawn(process.execPath, ["-e", script], { detached: true });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.on("data", (buf) => {
      if (buf.toString().includes("ready")) resolve(child);
    });
  });
}

test("killProcess stops a real short-lived child (stopped:true via SIGTERM)", async () => {
  const child = await spawnReadyChild("console.log('ready'); setInterval(() => {}, 60000)");
  const res = await killProcess({ pid: child.pid, graceMs: 3000, pollMs: 50 });
  assert.equal(res.stopped, true);
});

test("killProcess escalates to SIGKILL (forced:true) for a child that ignores SIGTERM", async () => {
  // Traps SIGTERM (no-op) and keeps running; only the SIGKILL fallback stops it.
  const child = await spawnReadyChild("process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 60000)");
  const res = await killProcess({ pid: child.pid, graceMs: 500, pollMs: 50 });
  assert.equal(res.stopped, true);
  assert.equal(res.forced, true, "SIGTERM-ignoring child forces the SIGKILL escalation");
});

// Thread 1: a present-but-malformed --row-manifest must FAIL CLOSED (clear parse
// error), never be silently nulled into a misleading "may remain (untagged)"
// ledger even though a manifest file WAS supplied. Absent --row-manifest is the
// honest untagged path and stays fine (covered by the core tests above).
test("runCli: present-but-malformed --row-manifest fails closed with a clear parse error (not silent null)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "teardown-manifest-"));
  const provisionPath = join(dir, "provision.json");
  writeFileSync(provisionPath, JSON.stringify(PROVISION));
  const manifestPath = join(dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify({ notRows: [{ id: 1 }] })); // wrong shape

  const argv = ["--repo-root", "/r", "--provision-result", provisionPath, "--row-manifest", manifestPath];
  const sink = { write: () => true };
  await assert.rejects(
    runCli(argv, { stdout: sink, stderr: sink }),
    /--row-manifest .* malformed/i,
  );
});

test("parseUiReviewTeardownCliArgs: requires --repo-root and --provision-result", () => {
  assert.throws(() => parseUiReviewTeardownCliArgs(["--provision-result", "/p.json"]), /repo-root/);
  assert.throws(() => parseUiReviewTeardownCliArgs(["--repo-root", "/r"]), /provision-result/);
});

test("parseUiReviewTeardownCliArgs: --confirm is fail-safe (bare confirms, =false does not)", () => {
  const base = ["--repo-root", "/r", "--provision-result", "/p.json"];
  assert.equal(parseUiReviewTeardownCliArgs(base).confirm, false, "default is unconfirmed");
  assert.equal(parseUiReviewTeardownCliArgs([...base, "--confirm"]).confirm, true);
  assert.equal(parseUiReviewTeardownCliArgs([...base, "--confirm=false"]).confirm, false);
  assert.equal(parseUiReviewTeardownCliArgs([...base, "--no-stop-app"]).stopApp, false);
});
