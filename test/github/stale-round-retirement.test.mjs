import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { retireStaleRound } from "../../scripts/github/_stale-round-retirement.mjs";
import { buildGateFaninLedgerPath, buildGateReviewsDir, buildLogPath } from "../../scripts/github/_gate-artifact-paths.mjs";

const HEAD = "d".repeat(40);
const KEY = { repo: "owner/repo", pr: 7, gate: "draft_gate", headSha: HEAD };

async function withRound(fn) {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "stale-round-"));
  try {
    await writeFile(path.join(tmpRoot, `checkpoint-context-sentinel-draft-gate-coverage-${HEAD}.json`), "{}");
    await writeFile(path.join(tmpRoot, `checkpoint-dispatch-prompt-draft-gate-coverage-${HEAD}.json`), "{}");
    const dir = buildGateReviewsDir({ ...KEY, tmpRoot });
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "coverage.json"), "{}");
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
    assert.ok(result.refusal.recovery.includes(`--tmp-root ${tmpRoot}`));
    assert.ok(result.refusal.recovery.includes(`--findings-dir ${buildGateReviewsDir({ ...KEY, tmpRoot })}`));
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
