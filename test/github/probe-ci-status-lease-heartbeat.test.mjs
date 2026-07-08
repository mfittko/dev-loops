import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { watchCiStatus } from "../../scripts/github/probe-ci-status.mjs";

function prView(headSha, checkNames = []) {
  return JSON.stringify({
    headRefOid: headSha,
    statusCheckRollup: checkNames.map((name) => ({ name })),
  });
}
function checkRuns(runs) {
  return JSON.stringify({ check_runs: runs });
}
function statuses(items) {
  return JSON.stringify({ statuses: items });
}

// gh stub that keeps CI pending for every poll so the watch runs its full budget
// (>=2 polls) and exercises the inter-poll heartbeat loop before timing out.
async function withPendingGhStub(fn) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ci-lease-hb-"));
  try {
    const ghPath = path.join(tempDir, "gh");
    const script = [
      "#!/usr/bin/env node",
      'const argv = process.argv.slice(2).join(" ");',
      'const has = (n) => argv.includes(n);',
      `if (has("pr") && has("view")) { process.stdout.write(${JSON.stringify(prView("sha-a", ["build"]))}); process.exit(0); }`,
      `if (has("check-runs")) { process.stdout.write(${JSON.stringify(checkRuns([{ status: "in_progress", conclusion: null, name: "build" }]))}); process.exit(0); }`,
      `if (has("/status")) { process.stdout.write(${JSON.stringify(statuses([]))}); process.exit(0); }`,
      'process.stderr.write(`unexpected gh args: ${argv}\\n`); process.exit(97);',
      "",
    ].join("\n");
    await writeFile(ghPath, script, "utf8");
    await chmod(ghPath, 0o755);
    const env = { ...process.env, PATH: [tempDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter) };
    return await fn(env);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// Frozen clock advanced by delayImpl so the inter-poll heartbeat loop runs (the
// heartbeat only writes when time remains in the chunked delay) without sleeping.
function advancingClockDeps(env, extra = {}) {
  let nowMs = 1_000;
  return {
    env,
    ghCommand: "gh",
    // Advance the clock by less than the chunk so remainingMs stays > 0 for at
    // least one iteration, guaranteeing the co-located heartbeat fires.
    delayImpl: async (ms) => { nowMs += Math.min(ms, 1_000); },
    now: () => nowMs,
    ...extra,
  };
}

test("watchCiStatus heartbeats the runner-coordination lease during the inter-poll wait", async () => {
  await withPendingGhStub(async (env) => {
    let ownershipCalls = 0;
    const result = await watchCiStatus(
      { repo: "owner/repo", pr: 7, pollIntervalMs: 60_000, timeoutMs: 120_000 },
      advancingClockDeps(env, {
        ensureOwnershipImpl: async () => {
          ownershipCalls += 1;
          return { ok: true, status: "owner_confirmed" };
        },
      }),
    );
    assert.equal(result.status, "timeout");
    // Fails if the engine-level lease heartbeat is removed.
    assert.ok(ownershipCalls >= 1, `expected >= 1 lease heartbeat during the wait, got ${ownershipCalls}`);
  });
});

test("watchCiStatus treats a rejecting lease heartbeat as non-fatal", async () => {
  await withPendingGhStub(async (env) => {
    const result = await watchCiStatus(
      { repo: "owner/repo", pr: 7, pollIntervalMs: 60_000, timeoutMs: 120_000 },
      advancingClockDeps(env, {
        ensureOwnershipImpl: async () => { throw new Error("lease boom"); },
      }),
    );
    // The watch still returns its normal terminal result despite the failure.
    assert.equal(result.status, "timeout");
    assert.equal(result.settled, false);
  });
});
