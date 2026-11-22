import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { retireStaleRound } from "../../scripts/github/_stale-round-retirement.mjs";
import { buildGateEmitPlanPath, buildGateFaninLedgerPath, buildGateReviewsDir, buildLogPath } from "../../scripts/github/_gate-artifact-paths.mjs";

const HEAD = "d".repeat(40);
const KEY = { repo: "owner/repo", pr: 7, gate: "draft_gate", headSha: HEAD };
const FINISHED = JSON.stringify({ angle: "coverage", verdict: "clean", headSha: HEAD, findings: [] });

async function withRound(fn) {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "stale-round-"));
  try {
    await writeFile(path.join(tmpRoot, `checkpoint-context-sentinel-draft-gate-coverage-${HEAD}.json`), "{}");
    await writeFile(path.join(tmpRoot, `checkpoint-dispatch-prompt-draft-gate-coverage-${HEAD}.json`), "{}");
    const dir = buildGateReviewsDir({ ...KEY, tmpRoot });
    await mkdir(dir, { recursive: true });
    // The reviewer finished: a valid artifact newer than the sentinel, so the round is not live.
    await writeFile(path.join(dir, "coverage.json"), FINISHED);
    return await fn(tmpRoot);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

test("a partial round at the same head and gate is retired and reported as retiredRound", async () => {
  await withRound(async (tmpRoot) => {
    const { retiredRound } = await retireStaleRound({ ...KEY, tmpRoot });
    assert.equal(retiredRound.retired, 1);
    assert.equal(retiredRound.dispatchPromptRecords.length, 1);
    assert.equal(retiredRound.findingsDirRetired, true);
    assert.equal(existsSync(path.join(tmpRoot, `checkpoint-context-sentinel-draft-gate-coverage-${HEAD}.json`)), false);
    assert.equal(existsSync(buildGateReviewsDir({ ...KEY, tmpRoot })), false);
  });
});

test("a round with a posted verdict at the head is refused with a recovery and left in place", async () => {
  await withRound(async (tmpRoot) => {
    const ledger = buildGateFaninLedgerPath({ ...KEY, tmpRoot });
    await writeFile(ledger, "{}").catch(async () => { await mkdir(path.dirname(ledger), { recursive: true }); await writeFile(ledger, "{}"); });
    const result = await retireStaleRound({ ...KEY, tmpRoot });
    assert.equal(result.retiredRound, undefined);
    assert.match(result.refusal.recovery, /dev-loops-run scripts\/github\/retire-gate-round\.mjs/);
    assert.ok(result.refusal.recovery.includes(`--tmp-root ${JSON.stringify(tmpRoot)}`));
    assert.ok(result.refusal.recovery.includes(`--findings-dir ${JSON.stringify(buildGateReviewsDir({ ...KEY, tmpRoot }))}`));
    assert.doesNotMatch(result.refusal.recovery, /<why>/);
    assert.equal(existsSync(path.join(tmpRoot, `checkpoint-context-sentinel-draft-gate-coverage-${HEAD}.json`)), true);
  });
});

test("a recorded verdict with no live round (retired manually) does not refuse", async () => {
  await withRound(async (tmpRoot) => {
    const ledger = buildGateFaninLedgerPath({ ...KEY, tmpRoot });
    await mkdir(path.dirname(ledger), { recursive: true });
    await writeFile(ledger, "{}");
    await rm(path.join(tmpRoot, `checkpoint-context-sentinel-draft-gate-coverage-${HEAD}.json`));
    await rm(path.join(tmpRoot, `checkpoint-dispatch-prompt-draft-gate-coverage-${HEAD}.json`));
    await rm(buildGateReviewsDir({ ...KEY, tmpRoot }), { recursive: true });
    assert.deepEqual(await retireStaleRound({ ...KEY, tmpRoot }), { retiredRound: null });
    assert.equal(existsSync(ledger), true);
  });
});

test("another gate's round and a head with no round are untouched", async () => {
  await withRound(async (tmpRoot) => {
    assert.equal((await retireStaleRound({ ...KEY, gate: "pre_approval_gate", tmpRoot })).retiredRound, null);
    assert.equal((await retireStaleRound({ ...KEY, headSha: "e".repeat(40), tmpRoot })).retiredRound, null);
    assert.equal(existsSync(path.join(tmpRoot, `checkpoint-context-sentinel-draft-gate-coverage-${HEAD}.json`)), true);
  });
});

test("a findings log at the head also marks a posted verdict and is refused", async () => {
  await withRound(async (tmpRoot) => {
    const log = buildLogPath({ ...KEY, tmpRoot });
    await mkdir(path.dirname(log), { recursive: true });
    await writeFile(log, "{}");
    const result = await retireStaleRound({ ...KEY, tmpRoot });
    assert.match(result.refusal.error, /a verdict is already recorded/);
    assert.equal(existsSync(path.join(tmpRoot, `checkpoint-context-sentinel-draft-gate-coverage-${HEAD}.json`)), true);
  });
});

test("an abbreviated head is never retired automatically", async () => {
  await withRound(async (tmpRoot) => {
    assert.deepEqual(await retireStaleRound({ ...KEY, headSha: HEAD.slice(0, 12), tmpRoot }), { retiredRound: null });
    assert.equal(existsSync(path.join(tmpRoot, `checkpoint-context-sentinel-draft-gate-coverage-${HEAD}.json`)), true);
  });
});

test("the recovery command quotes a tmp root with a space and a findings dir path", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "stale-round-"));
  const tmpRoot = path.join(base, "a b", "tmp");
  try {
    await mkdir(buildGateReviewsDir({ ...KEY, tmpRoot }), { recursive: true });
    await writeFile(path.join(tmpRoot, `checkpoint-context-sentinel-draft-gate-coverage-${HEAD}.json`), "{}");
    const ledger = buildGateFaninLedgerPath({ ...KEY, tmpRoot });
    await mkdir(path.dirname(ledger), { recursive: true });
    await writeFile(ledger, "{}");
    const { refusal } = await retireStaleRound({ ...KEY, tmpRoot });
    assert.ok(refusal.recovery.includes(`--tmp-root "${tmpRoot}"`), refusal.recovery);
    assert.ok(refusal.recovery.includes(`--findings-dir "${buildGateReviewsDir({ ...KEY, tmpRoot })}"`), refusal.recovery);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("liveOnly leaves a findings directory with no sentinel or dispatch record in place", async () => {
  await withRound(async (tmpRoot) => {
    await rm(path.join(tmpRoot, `checkpoint-context-sentinel-draft-gate-coverage-${HEAD}.json`));
    await rm(path.join(tmpRoot, `checkpoint-dispatch-prompt-draft-gate-coverage-${HEAD}.json`));
    assert.deepEqual(await retireStaleRound({ ...KEY, tmpRoot, liveOnly: true }), { retiredRound: null });
    assert.equal(existsSync(buildGateReviewsDir({ ...KEY, tmpRoot })), true);
  });
});

test("a dispatch-record-only round is retired under liveOnly, with the findings dir under another root", async () => {
  const sentinelRoot = await mkdtemp(path.join(os.tmpdir(), "stale-round-"));
  const findingsRoot = await mkdtemp(path.join(os.tmpdir(), "stale-round-"));
  try {
    await writeFile(path.join(sentinelRoot, `checkpoint-dispatch-prompt-draft-gate-coverage-${HEAD}.json`), "{}");
    const dir = buildGateReviewsDir({ ...KEY, tmpRoot: findingsRoot });
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "coverage.json"), "{}");
    const { retiredRound } = await retireStaleRound({ ...KEY, tmpRoot: sentinelRoot, findingsTmpRoot: findingsRoot, liveOnly: true });
    assert.equal(retiredRound.dispatchPromptRecords.length, 1);
    assert.equal(retiredRound.findingsDirRetired, true);
    assert.equal(existsSync(dir), false);
  } finally {
    await rm(sentinelRoot, { recursive: true, force: true });
    await rm(findingsRoot, { recursive: true, force: true });
  }
});

const SENTINEL = `checkpoint-context-sentinel-draft-gate-coverage-${HEAD}.json`;

test("a live reviewer sentinel (no valid artifact newer than it) is refused with a recovery and left in place", async () => {
  for (const artifact of [null, "{}", JSON.stringify({ angle: "coverage", verdict: "clean", headSha: "e".repeat(40), findings: [] })]) {
    await withRound(async (tmpRoot) => {
      const file = path.join(buildGateReviewsDir({ ...KEY, tmpRoot }), "coverage.json");
      if (artifact === null) await rm(file); else await writeFile(file, artifact);
      const result = await retireStaleRound({ ...KEY, tmpRoot });
      assert.equal(result.retiredRound, undefined);
      assert.match(result.refusal.error, /reviewer sentinel\(s\) have no findings artifact newer than them/);
      assert.match(result.refusal.recovery, /--pending/);
      assert.match(result.refusal.recovery, /retire-gate-round\.mjs/);
      assert.equal(existsSync(path.join(tmpRoot, SENTINEL)), true);
    });
  }
});

test("an artifact older than the sentinel belongs to an earlier round, so the sentinel is live", async () => {
  await withRound(async (tmpRoot) => {
    const old = new Date(Date.now() - 60_000);
    await utimes(path.join(buildGateReviewsDir({ ...KEY, tmpRoot }), "coverage.json"), old, old);
    assert.match((await retireStaleRound({ ...KEY, tmpRoot })).refusal.error, /still be running/);
  });
});

// Two group units: group-a (angle alpha) and group-b (angle beta). The persisted emit plan maps each scope to its angles.
async function withGroupRound(planUnits, fn) {
  await withRound(async (tmpRoot) => {
    await rm(path.join(tmpRoot, SENTINEL));
    for (const g of ["a", "b"]) await writeFile(path.join(tmpRoot, `checkpoint-context-sentinel-draft-gate-group-${g}-${HEAD}.json`), "{}");
    const dir = buildGateReviewsDir({ ...KEY, tmpRoot });
    await rm(path.join(dir, "coverage.json"));
    if (planUnits) {
      const plan = buildGateEmitPlanPath({ ...KEY, tmpRoot });
      await mkdir(path.dirname(plan), { recursive: true });
      await writeFile(plan, JSON.stringify({ units: planUnits }));
    }
    return fn(tmpRoot, dir);
  });
}
const finishedArtifact = (angle) => JSON.stringify({ angle, verdict: "clean", headSha: HEAD, findings: [] });
const GROUP_UNITS = [{ scope: "draft-gate-group-a", angles: ["alpha"] }, { scope: "draft-gate-group-b", angles: ["beta"] }];

test("a group unit that finished does not make another running group unit finished: the round is refused and nothing moves", async () => {
  await withGroupRound(GROUP_UNITS, async (tmpRoot, dir) => {
    await writeFile(path.join(dir, "alpha.json"), finishedArtifact("alpha")); // group-a finished; group-b still reviewing
    const result = await retireStaleRound({ ...KEY, tmpRoot });
    assert.equal(result.retiredRound, undefined);
    assert.match(result.refusal.error, /1 reviewer sentinel\(s\)[^]*group-b/);
    assert.equal(existsSync(path.join(tmpRoot, `checkpoint-context-sentinel-draft-gate-group-a-${HEAD}.json`)), true);
    assert.equal(existsSync(path.join(dir, "alpha.json")), true);
  });
});

test("group units retire once every angle of each unit has a valid newer artifact", async () => {
  await withGroupRound(GROUP_UNITS, async (tmpRoot, dir) => {
    for (const angle of ["alpha", "beta"]) await writeFile(path.join(dir, `${angle}.json`), finishedArtifact(angle));
    assert.equal((await retireStaleRound({ ...KEY, tmpRoot })).retiredRound.retired, 2);
  });
});

test("a group sentinel with no emit plan, no plan entry or a plan that is not JSON stays live", async () => {
  for (const planUnits of [null, [{ scope: "draft-gate-group-a", angles: ["alpha"] }]]) {
    await withGroupRound(planUnits, async (tmpRoot, dir) => {
      for (const angle of ["alpha", "beta"]) await writeFile(path.join(dir, `${angle}.json`), finishedArtifact(angle));
      assert.match((await retireStaleRound({ ...KEY, tmpRoot })).refusal.error, /still be running/);
    });
  }
  await withGroupRound(GROUP_UNITS, async (tmpRoot, dir) => {
    for (const angle of ["alpha", "beta"]) await writeFile(path.join(dir, `${angle}.json`), finishedArtifact(angle));
    await writeFile(buildGateEmitPlanPath({ ...KEY, tmpRoot }), "{ truncated");
    assert.match((await retireStaleRound({ ...KEY, tmpRoot })).refusal.error, /still be running/);
  });
});

test("a distinct records root retires the dispatch records the emitter wrote there", async () => {
  const sentinelRoot = await mkdtemp(path.join(os.tmpdir(), "stale-round-"));
  const recordsRoot = await mkdtemp(path.join(os.tmpdir(), "stale-round-"));
  try {
    await writeFile(path.join(recordsRoot, `checkpoint-dispatch-prompt-draft-gate-coverage-${HEAD}.json`), "{}");
    const { retiredRound } = await retireStaleRound({ ...KEY, tmpRoot: sentinelRoot, recordsTmpRoot: recordsRoot, liveOnly: true });
    assert.deepEqual(retiredRound.dispatchPromptRecords, [`checkpoint-dispatch-prompt-draft-gate-coverage-${HEAD}.json`]);
    assert.equal(existsSync(path.join(recordsRoot, `checkpoint-dispatch-prompt-draft-gate-coverage-${HEAD}.json`)), false);
  } finally {
    await rm(sentinelRoot, { recursive: true, force: true });
    await rm(recordsRoot, { recursive: true, force: true });
  }
});

test("an error other than ENOENT reading a verdict marker fails closed instead of retiring (ENOTDIR, EACCES, EIO share one path)", async () => {
  // ENOTDIR: the ledger's parent is a file, so access() fails with ENOTDIR, not ENOENT.
  await withRound(async (tmpRoot) => {
    const ledger = buildGateFaninLedgerPath({ ...KEY, tmpRoot });
    let parent = path.dirname(ledger);
    while (path.dirname(parent) !== tmpRoot) parent = path.dirname(parent);
    await writeFile(parent, "not a directory");
    await assert.rejects(retireStaleRound({ ...KEY, tmpRoot }), (err) => err.code === "ENOTDIR");
    assert.equal(existsSync(path.join(tmpRoot, SENTINEL)), true);
  });
  // EACCES: the ledger's parent lacks search permission (a no-op check as root, which ignores modes).
  if (process.getuid?.() !== 0) {
    await withRound(async (tmpRoot) => {
      const ledger = buildGateFaninLedgerPath({ ...KEY, tmpRoot });
      await mkdir(path.dirname(ledger), { recursive: true });
      await writeFile(ledger, "{}");
      await chmod(path.dirname(ledger), 0o000);
      try {
        await assert.rejects(retireStaleRound({ ...KEY, tmpRoot }), (err) => err.code === "EACCES");
        assert.equal(existsSync(path.join(tmpRoot, SENTINEL)), true);
      } finally {
        await chmod(path.dirname(ledger), 0o755);
      }
    });
  }
});

test("an unreadable tmp root (ENOTDIR) is not treated as an empty round", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "stale-round-"));
  try {
    const tmpRoot = path.join(base, "file");
    await writeFile(tmpRoot, "x");
    await assert.rejects(retireStaleRound({ ...KEY, tmpRoot }), (err) => err.code === "ENOTDIR");
    assert.deepEqual(await retireStaleRound({ ...KEY, tmpRoot: path.join(base, "missing") }), { retiredRound: null });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
