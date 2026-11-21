import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "bun:test";

import { acquireSlot, ghExecFileSync, resetThrottleCache, resolveIntervalMs, resolveMainRoot, takeGhSlot, takeGhSlotSync } from "../src/github/gh-throttle.mjs";
import { GH_STUB_ATTESTATION_ENV } from "../src/github/test-mode-write-guard.mjs";

let root;
let clock;
const sleep = async (ms) => { clock += ms; };
const now = () => clock;
const slotFile = () => path.join(root, "tmp", "gh-throttle", "next-slot");
const lockFile = () => path.join(root, "tmp", "gh-throttle", "lock");

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "issue-3340-throttle-"));
  clock = Date.now();
  resetThrottleCache();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("gh-throttle", () => {
  test("two concurrent callers start at least one interval apart", async () => {
    // A frozen clock with a recording sleep: the reservations, not wall time, carry the assertion.
    // Two slots one interval apart leave next-slot at t0 + 2 * interval, and the second caller waits one interval.
    const waits = [];
    const caller = () => acquireSlot({ root, intervalMs: 60, now, sleep: async (ms) => { waits.push(ms); } });
    const t0 = clock;
    await Promise.all([caller(), caller()]);
    assert.equal(Number(await readFile(slotFile(), "utf8")), t0 + 120);
    assert.ok(waits.includes(60), `waits ${waits}`);
  });

  test("release deletes only its own token: a lock another holder took is left in place", async () => {
    await acquireSlot({
      root,
      intervalMs: 500,
      sleep,
      // now() runs inside the critical section: swap the lock for another holder's.
      now: () => { if (existsSync(lockFile())) writeFileSync(lockFile(), "other-holder"); return clock; },
    });
    assert.equal(await readFile(lockFile(), "utf8"), "other-holder");
  });

  test("release removes the lock when the token still matches", async () => {
    await acquireSlot({ root, intervalMs: 500, now, sleep });
    await assert.rejects(() => readFile(lockFile()), { code: "ENOENT" });
  });

  test("a stolen stale lock leaves no aside file behind", async () => {
    await mkdir(path.dirname(lockFile()), { recursive: true });
    await writeFile(lockFile(), "dead-holder");
    const old = new Date(clock - 60_000);
    await utimes(lockFile(), old, old);
    await acquireSlot({ root, intervalMs: 500, now, sleep });
    assert.deepEqual((await readdir(path.dirname(lockFile()))).sort(), ["next-slot"]);
  });

  test("a lock a creator replaced during the steal is left in place: one holder", async () => {
    await mkdir(path.dirname(lockFile()), { recursive: true });
    await writeFile(lockFile(), "dead-holder");
    const base = clock;
    // now() calls: deadline, the steal's staleness check (a creator swaps in a fresh lock here), then past the deadline.
    let calls = 0;
    const racingNow = () => {
      calls += 1;
      if (calls === 2) { writeFileSync(lockFile(), "fresh-holder"); return base + 60_000; }
      return calls === 1 ? base : base + 1000;
    };
    await assert.rejects(
      () => acquireSlot({ root, intervalMs: 500, now: racingNow, sleep, lockTimeoutMs: 100 }),
      { code: "GH_THROTTLE_UNAVAILABLE" },
    );
    assert.equal(await readFile(lockFile(), "utf8"), "fresh-holder");
    assert.deepEqual((await readdir(path.dirname(lockFile()))).sort(), ["lock"]);
  });

  test("a stale-mtime lock whose holder pid is alive is not stolen", async () => {
    await mkdir(path.dirname(lockFile()), { recursive: true });
    await writeFile(lockFile(), `${process.pid}:paused-holder`);
    const old = new Date(clock - 60_000);
    await utimes(lockFile(), old, old);
    await assert.rejects(
      () => acquireSlot({ root, intervalMs: 500, now, sleep, lockTimeoutMs: 100 }),
      { code: "GH_THROTTLE_UNAVAILABLE" },
    );
    assert.equal(await readFile(lockFile(), "utf8"), `${process.pid}:paused-holder`);
  });

  test("a next-slot an hour ahead (clock stepped back) is treated as no reservation", async () => {
    await mkdir(path.dirname(slotFile()), { recursive: true });
    await writeFile(slotFile(), String(clock + 3_600_000));
    const before = clock;
    await acquireSlot({ root, intervalMs: 500, now, sleep });
    assert.ok(clock - before <= 500, `waited ${clock - before}`);
    assert.equal(Number(await readFile(slotFile(), "utf8")), before + 500);
  });

  test("interval 0 skips the lock and the state dir", async () => {
    await acquireSlot({ root, intervalMs: 0, now, sleep });
    await assert.rejects(() => readFile(slotFile()), { code: "ENOENT" });
  });

  test("a missing next-slot file starts immediately and records the next slot", async () => {
    const before = clock;
    await acquireSlot({ root, intervalMs: 500, now, sleep });
    assert.equal(clock, before);
    assert.equal(Number(await readFile(slotFile(), "utf8")), before + 500);
  });

  test("a garbage next-slot file is treated as no reservation", async () => {
    await mkdir(path.dirname(slotFile()), { recursive: true });
    await writeFile(slotFile(), "not a number");
    const before = clock;
    await acquireSlot({ root, intervalMs: 500, now, sleep });
    assert.equal(clock, before);
  });

  test("an unreadable next-slot file is an error, never a skipped lock", async () => {
    await mkdir(slotFile(), { recursive: true });
    await assert.rejects(() => acquireSlot({ root, intervalMs: 500, now, sleep }), { code: "GH_THROTTLE_UNAVAILABLE" });
    await assert.rejects(() => readFile(lockFile()), { code: "ENOENT" });
  });

  test("a stale lock is stolen", async () => {
    await mkdir(path.dirname(lockFile()), { recursive: true });
    await writeFile(lockFile(), "");
    const old = new Date(clock - 60_000);
    await utimes(lockFile(), old, old);
    await acquireSlot({ root, intervalMs: 500, now, sleep });
    assert.ok(Number(await readFile(slotFile(), "utf8")) > 0);
  });

  test("a fresh lock held past the timeout throws GH_THROTTLE_UNAVAILABLE", async () => {
    await mkdir(path.dirname(lockFile()), { recursive: true });
    await writeFile(lockFile(), "");
    await assert.rejects(
      () => acquireSlot({ root, intervalMs: 500, now, sleep, lockTimeoutMs: 100, staleLockMs: 10 * 60_000 }),
      { code: "GH_THROTTLE_UNAVAILABLE" },
    );
  });

  test("a failing root resolution throws GH_THROTTLE_UNAVAILABLE", () => {
    const execFile = () => { throw new Error("not a git repository"); };
    assert.throws(() => resolveMainRoot({ execFile }), { code: "GH_THROTTLE_UNAVAILABLE", message: /not a git repository/ });
  });

  test("the root resolution git call carries a timeout", () => {
    let options;
    resolveMainRoot({ execFile: (_cmd, _args, opts) => { options = opts; return "/repo/.git"; } });
    assert.ok(options.timeout > 0);
  });

  test("takeGhSlot composes root and configured interval into a reserved slot", async () => {
    await writeFile(path.join(root, ".devloops"), "version: 1\nqueue:\n  ghMinIntervalMs: 120\n");
    await takeGhSlot({ execFile: () => `${path.join(root, ".git")}\n`, now, sleep });
    assert.equal(Number(await readFile(slotFile(), "utf8")), clock + 120);
  });

  test("takeGhSlot is unpaced only for an attested gh stub; NODE_ENV=test without the stub is paced", async () => {
    const saved = { NODE_ENV: process.env.NODE_ENV, stub: process.env[GH_STUB_ATTESTATION_ENV] };
    delete process.env[GH_STUB_ATTESTATION_ENV];
    process.env.NODE_ENV = "test";
    try {
      const execFile = () => { throw new Error("must not resolve a root"); };
      await takeGhSlot({ execFile, env: { [GH_STUB_ATTESTATION_ENV]: "1" } });
      await assert.rejects(() => takeGhSlot({ execFile }), { code: "GH_THROTTLE_UNAVAILABLE" });
      await takeGhSlot({ execFile: () => `${path.join(root, ".git")}\n`, intervalMs: 120, now, sleep });
      assert.equal(Number(await readFile(slotFile(), "utf8")), clock + 120);
    } finally {
      process.env.NODE_ENV = saved.NODE_ENV;
      if (saved.stub === undefined) delete process.env[GH_STUB_ATTESTATION_ENV];
      else process.env[GH_STUB_ATTESTATION_ENV] = saved.stub;
    }
  });

  test("takeGhSlotSync fails closed: a failing slot child becomes GH_THROTTLE_UNAVAILABLE with its stderr", () => {
    const execFile = () => { throw Object.assign(new Error("x"), { stderr: "boom" }); };
    assert.throws(() => takeGhSlotSync({ execFile }), { code: "GH_THROTTLE_UNAVAILABLE", message: /boom/ });
  });

  test("ghExecFileSync forwards the call env and cwd to the slot child", () => {
    let seen;
    const takeSlotSync = (opts) => { seen = opts; };
    ghExecFileSync("gh", ["x"], { env: { A: "1" }, cwd: "/some/repo" }, { execFile: () => "ok", takeSlotSync });
    assert.deepEqual(seen, { env: { A: "1" }, cwd: "/some/repo" });
  });

  test("ghExecFileSync backs off once on a secondary rate limit, then throws RATE_LIMITED", () => {
    const limited = () => { throw Object.assign(new Error("failed"), { stderr: "You have exceeded a secondary rate limit" }); };
    const backoffs = [];
    let runs = 0;
    const deps = (impl) => ({ execFile: () => { runs += 1; return impl(runs); }, takeSlotSync: () => {}, backoff: (ms) => backoffs.push(ms), backoffMs: 7 });
    assert.equal(ghExecFileSync("gh", ["x"], {}, deps((n) => (n === 1 ? limited() : "ok"))), "ok");
    assert.deepEqual(backoffs, [7]);
    runs = 0;
    assert.throws(() => ghExecFileSync("gh", ["x"], {}, deps(limited)), { code: "RATE_LIMITED", message: /secondary rate limit/ });
    assert.equal(runs, 2);
  });

  test("a config load failure warns exactly once per process", async () => {
    const warnings = [];
    const warn = (message) => warnings.push(message);
    const loadConfig = async () => { throw new Error("boom"); };
    assert.equal(await resolveIntervalMs(root, { warn, loadConfig }), 500);
    await resolveIntervalMs(root, { warn, loadConfig });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /config load failed/);
  });

  test("the main root is the parent of the git common dir and is cached", () => {
    let calls = 0;
    const execFile = () => { calls += 1; return "/repo/main/.git\n"; };
    assert.equal(resolveMainRoot({ execFile }), "/repo/main");
    assert.equal(resolveMainRoot({ execFile }), "/repo/main");
    assert.equal(calls, 1);
  });

  test("the interval reads the .devloops override from the root", async () => {
    await writeFile(path.join(root, ".devloops"), "version: 1\nqueue:\n  ghMinIntervalMs: 120\n");
    assert.equal(await resolveIntervalMs(root), 120);
  });

  test("a root without a config file uses the default 500", async () => {
    assert.equal(await resolveIntervalMs(path.join(root, "does-not-exist")), 500);
  });
});
