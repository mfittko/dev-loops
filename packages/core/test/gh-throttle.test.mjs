import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "bun:test";

import { acquireSlot, resetThrottleCache, resolveIntervalMs, resolveMainRoot, takeGhSlot } from "../src/github/gh-throttle.mjs";

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
    // The shared fake clock also advances during lock polling, so assert on the
    // reservations: two slots one interval apart end at t0 + 2 * interval or later.
    // Real clock: each caller records its wall time right after acquireSlot returns.
    const starts = [];
    const caller = async () => {
      await acquireSlot({ root, intervalMs: 60 });
      starts.push(Date.now());
    };
    await Promise.all([caller(), caller()]);
    starts.sort((a, b) => a - b);
    assert.equal(starts.length, 2);
    assert.ok(starts[1] - starts[0] >= 55, `gap ${starts[1] - starts[0]}`);
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

  test("a lock that is fresh once moved aside is restored, not stolen", async () => {
    await mkdir(path.dirname(lockFile()), { recursive: true });
    await writeFile(lockFile(), "live-holder");
    const base = clock;
    // now() calls: deadline, stale check (stale), steal re-verify (fresh), then past the deadline.
    const readings = [base, base + 60_000, base];
    const racingNow = () => readings.length > 0 ? readings.shift() : base + 1000;
    await assert.rejects(
      () => acquireSlot({ root, intervalMs: 500, now: racingNow, sleep, lockTimeoutMs: 100 }),
      { code: "GH_THROTTLE_UNAVAILABLE" },
    );
    assert.equal(await readFile(lockFile(), "utf8"), "live-holder");
    assert.deepEqual((await readdir(path.dirname(lockFile()))).sort(), ["lock"]);
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
