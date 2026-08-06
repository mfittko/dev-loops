import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runNode as runNodeHelper } from "../_helpers.mjs";

import { parseCiWatchCliArgs, watchCiStatus } from "../../scripts/github/probe-ci-status.mjs";

const scriptPath = path.resolve("scripts/github/probe-ci-status.mjs");
const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

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

// Router-style gh stub: matches each call's args against a rule and returns its
// stdout. Repeatable (steady-state polling) by default; `routesBySha` lets a
// later poll observe an advanced head SHA. Avoids real sleeping/network.
async function withGhStub({ routes = [], shaSequence = null }, fn) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-watch-ci-"));
  try {
    const ghPath = path.join(tempDir, "gh");
    const counterPath = path.join(tempDir, "prview-counter.txt");
    await writeFile(counterPath, "0", "utf8");
    const script = [
      "#!/usr/bin/env node",
      'const { readFileSync, writeFileSync } = require("node:fs");',
      `const routes = ${JSON.stringify(routes)};`,
      `const shaSequence = ${JSON.stringify(shaSequence)};`,
      `const counterPath = ${JSON.stringify(counterPath)};`,
      'const argv = process.argv.slice(2).join(" ");',
      'function match(needles) { return needles.every((n) => argv.includes(n)); }',
      'if (shaSequence && match(["pr", "view"])) {',
      '  const i = Number(readFileSync(counterPath, "utf8").trim() || "0");',
      '  writeFileSync(counterPath, String(i + 1));',
      '  const sha = shaSequence[Math.min(i, shaSequence.length - 1)];',
      `  process.stdout.write(JSON.stringify({ headRefOid: sha, statusCheckRollup: [{ name: "build" }] }));`,
      '  process.exit(0);',
      '}',
      'for (const r of routes) {',
      '  if (match(r.match)) { process.stdout.write(r.stdout); process.exit(r.exitCode ?? 0); }',
      '}',
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

// check-runs route that reports in_progress on the first poll and success
// afterwards (counter-file backed), so a pending->success transition is testable.
async function withGhStubFlip(fn) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-watch-ci-flip-"));
  try {
    const ghPath = path.join(tempDir, "gh");
    const counterPath = path.join(tempDir, "checkruns-counter.txt");
    await writeFile(counterPath, "0", "utf8");
    const script = [
      "#!/usr/bin/env node",
      'const { readFileSync, writeFileSync } = require("node:fs");',
      `const counterPath = ${JSON.stringify(counterPath)};`,
      'const argv = process.argv.slice(2).join(" ");',
      'const has = (n) => argv.includes(n);',
      `if (has("pr") && has("view")) { process.stdout.write(${JSON.stringify(prView("sha-a", ["build"]))}); process.exit(0); }`,
      'if (has("check-runs")) {',
      '  const i = Number(readFileSync(counterPath, "utf8").trim() || "0");',
      '  writeFileSync(counterPath, String(i + 1));',
      `  const run = i === 0 ? { status: "in_progress", conclusion: null, name: "build" } : { status: "completed", conclusion: "success", name: "build" };`,
      '  process.stdout.write(JSON.stringify({ check_runs: [run] })); process.exit(0);',
      '}',
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

// No real sleeping: inject a no-op delay + frozen clock.
const fastDeps = (env) => ({ env, ghCommand: "gh", delayImpl: async () => {}, now: () => 1_000 });

test("watch-ci returns terminal success when all checks pass", async () => {
  await withGhStub(
    {
      routes: [
        { match: ["pr", "view"], stdout: prView("sha-a", ["build"]) },
        { match: ["check-runs"], stdout: checkRuns([{ status: "completed", conclusion: "success", name: "build" }]) },
        { match: ["/status"], stdout: statuses([]) },
      ],
    },
    async (env) => {
      const result = await watchCiStatus({ repo: "owner/repo", pr: 7, pollIntervalMs: 10, timeoutMs: 100 }, fastDeps(env));
      assert.equal(result.status, "success");
      assert.equal(result.settled, true);
      assert.equal(result.ciStatus, "success");
      assert.equal(result.headSha, "sha-a");
      assert.deepEqual(result.failedChecks, []);
    },
  );
});

test("watch-ci returns terminal failure with failedChecks populated", async () => {
  await withGhStub(
    {
      routes: [
        { match: ["pr", "view"], stdout: prView("sha-a", ["lint"]) },
        { match: ["check-runs"], stdout: checkRuns([{ status: "completed", conclusion: "failure", name: "lint" }]) },
        { match: ["/status"], stdout: statuses([]) },
      ],
    },
    async (env) => {
      const result = await watchCiStatus({ repo: "owner/repo", pr: 7, pollIntervalMs: 10, timeoutMs: 100 }, fastDeps(env));
      assert.equal(result.status, "failure");
      assert.equal(result.settled, true);
      assert.equal(result.ciStatus, "failure");
      assert.deepEqual(result.failedChecks, [{ name: "lint" }]);
    },
  );
});

test("watch-ci transitions pending -> success across polls", async () => {
  await withGhStubFlip(async (env) => {
    const result = await watchCiStatus({ repo: "owner/repo", pr: 7, pollIntervalMs: 10, timeoutMs: 100 }, fastDeps(env));
    assert.equal(result.status, "success");
    assert.equal(result.attempts, 2);
  });
});

test("watch-ci returns timeout when CI stays pending past the budget", async () => {
  await withGhStub(
    {
      routes: [
        { match: ["pr", "view"], stdout: prView("sha-a", ["build"]) },
        { match: ["check-runs"], stdout: checkRuns([{ status: "in_progress", conclusion: null, name: "build" }]) },
        { match: ["/status"], stdout: statuses([]) },
      ],
    },
    async (env) => {
      const result = await watchCiStatus({ repo: "owner/repo", pr: 7, pollIntervalMs: 10, timeoutMs: 25 }, fastDeps(env));
      assert.equal(result.status, "timeout");
      assert.equal(result.settled, false);
      assert.equal(result.ciStatus, "pending");
    },
  );
});

test("watch-ci returns changed when the head SHA advances mid-wait", async () => {
  // Poll 1 sees sha-a (pending); poll 2 sees the advanced sha-b -> changed.
  await withGhStub(
    {
      shaSequence: ["sha-a", "sha-a", "sha-b"],
      routes: [
        { match: ["check-runs"], stdout: checkRuns([{ status: "in_progress", conclusion: null, name: "build" }]) },
        { match: ["/status"], stdout: statuses([]) },
      ],
    },
    async (env) => {
      const result = await watchCiStatus({ repo: "owner/repo", pr: 7, pollIntervalMs: 10, timeoutMs: 100 }, fastDeps(env));
      assert.equal(result.status, "changed");
      assert.equal(result.settled, false);
      assert.equal(result.headSha, "sha-b");
    },
  );
});

test("watch-ci settles no-checks success only after the grace window", async () => {
  // Genuinely check-less repo (empty rollup, zero check-runs/statuses): does NOT
  // settle on the first poll, settles after NO_CHECKS_GRACE_POLLS (2).
  await withGhStub(
    {
      routes: [
        { match: ["pr", "view"], stdout: prView("sha-a", []) },
        { match: ["check-runs"], stdout: checkRuns([]) },
        { match: ["/status"], stdout: statuses([]) },
      ],
    },
    async (env) => {
      const result = await watchCiStatus({ repo: "owner/repo", pr: 7, pollIntervalMs: 10, timeoutMs: 100 }, fastDeps(env));
      assert.equal(result.status, "success");
      assert.equal(result.settled, true);
      assert.equal(result.ciStatus, "none");
      assert.equal(result.attempts, 2); // grace: not the first poll
    },
  );
});

test("watch-ci single check (timeout-ms 0) settles no-checks success immediately", async () => {
  // No waiting budget → no grace window → a clean no-checks head reports at once.
  await withGhStub(
    {
      routes: [
        { match: ["pr", "view"], stdout: prView("sha-a", []) },
        { match: ["check-runs"], stdout: checkRuns([]) },
        { match: ["/status"], stdout: statuses([]) },
      ],
    },
    async (env) => {
      const result = await watchCiStatus({ repo: "owner/repo", pr: 7, pollIntervalMs: 10, timeoutMs: 0 }, fastDeps(env));
      assert.equal(result.status, "success");
      assert.equal(result.ciStatus, "none");
      assert.equal(result.attempts, 1);
    },
  );
});

test("watch-ci does NOT settle no-checks early when a check appears after zero-check polls", async () => {
  // Poll 1: zero check-runs (provider hasn't registered yet). Poll 2: a terminal
  // check appears. Must classify the check, NOT fabricate success on the race.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-watch-ci-late-"));
  try {
    const ghPath = path.join(tempDir, "gh");
    const counterPath = path.join(tempDir, "cr-counter.txt");
    await writeFile(counterPath, "0", "utf8");
    const script = [
      "#!/usr/bin/env node",
      'const { readFileSync, writeFileSync } = require("node:fs");',
      `const counterPath = ${JSON.stringify(counterPath)};`,
      'const argv = process.argv.slice(2).join(" ");',
      'const has = (n) => argv.includes(n);',
      // Rollup lists no expected check on poll 1 (provider hasn't registered),
      // so the head looks check-less until the run appears.
      'if (has("pr") && has("view")) { process.stdout.write(JSON.stringify({ headRefOid: "sha-a", statusCheckRollup: [] })); process.exit(0); }',
      'if (has("check-runs")) {',
      '  const i = Number(readFileSync(counterPath, "utf8").trim() || "0");',
      '  writeFileSync(counterPath, String(i + 1));',
      '  const runs = i === 0 ? [] : [{ status: "completed", conclusion: "success", name: "build" }];',
      '  process.stdout.write(JSON.stringify({ check_runs: runs })); process.exit(0);',
      '}',
      `if (has("/status")) { process.stdout.write(${JSON.stringify(statuses([]))}); process.exit(0); }`,
      'process.stderr.write(`unexpected gh args: ${argv}\\n`); process.exit(97);',
      "",
    ].join("\n");
    await writeFile(ghPath, script, "utf8");
    await chmod(ghPath, 0o755);
    const env = { ...process.env, PATH: [tempDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter) };
    const result = await watchCiStatus({ repo: "owner/repo", pr: 7, pollIntervalMs: 10, timeoutMs: 100 }, fastDeps(env));
    assert.equal(result.status, "success");
    assert.equal(result.ciStatus, "success"); // classified the real check, not none
    assert.equal(result.attempts, 2);
    assert.deepEqual(result.failedChecks, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("watch-ci treats expected-but-unreported checks (rollup) as pending, not none", async () => {
  // statusCheckRollup lists an expected "build" check, but the check-runs/status
  // APIs report zero terminal -> pending the whole budget, then timeout. Never none/success.
  await withGhStub(
    {
      routes: [
        { match: ["pr", "view"], stdout: prView("sha-a", ["build"]) },
        { match: ["check-runs"], stdout: checkRuns([]) },
        { match: ["/status"], stdout: statuses([]) },
      ],
    },
    async (env) => {
      const result = await watchCiStatus({ repo: "owner/repo", pr: 7, pollIntervalMs: 10, timeoutMs: 25 }, fastDeps(env));
      // Expected-but-unreported checks suppress the no-checks settle: the watcher
      // waits out the budget (timeout) instead of fabricating a success.
      assert.equal(result.status, "timeout");
      assert.equal(result.settled, false);
      assert.notEqual(result.status, "success");
    },
  );
});

test("watch-ci never fabricates success from a gh-api error on check-runs", async () => {
  // check-runs API errors (non-zero exit) with zero statuses: must NOT be read
  // as empty -> keep polling -> timeout, never success.
  await withGhStub(
    {
      routes: [
        { match: ["pr", "view"], stdout: prView("sha-a", []) },
        { match: ["check-runs"], stdout: "boom\n", exitCode: 1 },
        { match: ["/status"], stdout: statuses([]) },
      ],
    },
    async (env) => {
      const result = await watchCiStatus({ repo: "owner/repo", pr: 7, pollIntervalMs: 10, timeoutMs: 30 }, fastDeps(env));
      assert.equal(result.status, "timeout");
      assert.notEqual(result.status, "success");
      assert.equal(result.ciStatus, "pending");
    },
  );
});

test("watch-ci single check (timeout-ms 0) reports live pending without waiting", async () => {
  await withGhStub(
    {
      routes: [
        { match: ["pr", "view"], stdout: prView("sha-a", ["build"]) },
        { match: ["check-runs"], stdout: checkRuns([{ status: "queued", conclusion: null, name: "build" }]) },
        { match: ["/status"], stdout: statuses([]) },
      ],
    },
    async (env) => {
      const result = await watchCiStatus({ repo: "owner/repo", pr: 7, pollIntervalMs: 10, timeoutMs: 0 }, fastDeps(env));
      assert.equal(result.status, "pending");
      assert.equal(result.attempts, 1);
    },
  );
});

test("watch-ci uses per-poll rollup names: empty then populated for the SAME sha stays pending", async () => {
  // Poll 1: statusCheckRollup is empty (provider hasn't registered the check) and
  // check-runs are empty -> looks check-less. Poll 2+: the SAME sha now lists an
  // expected "build" check in the rollup, but check-runs still report zero.
  // With the (buggy) baseline rollup names this would settle none->success at the
  // grace floor; with per-poll currentNames the expected check suppresses the
  // no-checks settle, so it waits out the budget -> timeout. Never success.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-watch-ci-perpoll-"));
  try {
    const ghPath = path.join(tempDir, "gh");
    const counterPath = path.join(tempDir, "prview-counter.txt");
    await writeFile(counterPath, "0", "utf8");
    const script = [
      "#!/usr/bin/env node",
      'const { readFileSync, writeFileSync } = require("node:fs");',
      `const counterPath = ${JSON.stringify(counterPath)};`,
      'const argv = process.argv.slice(2).join(" ");',
      'const has = (n) => argv.includes(n);',
      'if (has("pr") && has("view")) {',
      '  const i = Number(readFileSync(counterPath, "utf8").trim() || "0");',
      '  writeFileSync(counterPath, String(i + 1));',
      '  const rollup = i === 0 ? [] : [{ name: "build" }];',
      '  process.stdout.write(JSON.stringify({ headRefOid: "sha-a", statusCheckRollup: rollup }));',
      '  process.exit(0);',
      '}',
      `if (has("check-runs")) { process.stdout.write(${JSON.stringify(checkRuns([]))}); process.exit(0); }`,
      `if (has("/status")) { process.stdout.write(${JSON.stringify(statuses([]))}); process.exit(0); }`,
      'process.stderr.write(`unexpected gh args: ${argv}\\n`); process.exit(97);',
      "",
    ].join("\n");
    await writeFile(ghPath, script, "utf8");
    await chmod(ghPath, 0o755);
    const env = { ...process.env, PATH: [tempDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter) };
    const result = await watchCiStatus({ repo: "owner/repo", pr: 7, pollIntervalMs: 10, timeoutMs: 30 }, fastDeps(env));
    // The expected-but-unreported check (from the per-poll populated rollup)
    // suppresses the no-checks settle: with stale baseline names this would have
    // settled success at the grace floor instead of waiting out the budget.
    assert.equal(result.status, "timeout");
    assert.equal(result.settled, false);
    assert.notEqual(result.status, "success");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("watch-ci surfaces a commit-status failure with NO check-runs (CircleCI)", async () => {
  // CircleCI-style: failure reported via the commit-STATUS API as a context,
  // with zero check-runs. ciStatus must be "failure" AND failedChecks must
  // include the failing context (name + state), not be empty.
  await withGhStub(
    {
      routes: [
        { match: ["pr", "view"], stdout: prView("sha-a", []) },
        { match: ["check-runs"], stdout: checkRuns([]) },
        { match: ["/status"], stdout: statuses([{ state: "failure", context: "ci/circleci: build" }]) },
      ],
    },
    async (env) => {
      const result = await watchCiStatus({ repo: "owner/repo", pr: 7, pollIntervalMs: 10, timeoutMs: 100 }, fastDeps(env));
      assert.equal(result.status, "failure");
      assert.equal(result.settled, true);
      assert.equal(result.ciStatus, "failure");
      assert.deepEqual(result.failedChecks, [{ name: "ci/circleci: build", conclusion: "failure" }]);
    },
  );
});

test("watch-ci polls at t=0: an already-green head settles in one attempt with zero delay", async () => {
  // The first poll must run before any delay, so a head whose CI is already
  // terminal settles immediately (attempts=1) without waiting a poll interval.
  let delayCalls = 0;
  await withGhStub(
    {
      routes: [
        { match: ["pr", "view"], stdout: prView("sha-a", ["build"]) },
        { match: ["check-runs"], stdout: checkRuns([{ status: "completed", conclusion: "success", name: "build" }]) },
        { match: ["/status"], stdout: statuses([]) },
      ],
    },
    async (env) => {
      const result = await watchCiStatus(
        { repo: "owner/repo", pr: 7, pollIntervalMs: 10, timeoutMs: 100 },
        {
          env,
          ghCommand: "gh",
          delayImpl: async () => { delayCalls += 1; },
          now: () => 1_000,
        },
      );
      assert.equal(result.status, "success");
      assert.equal(result.attempts, 1);
      // Settled on the immediate t=0 poll: no sleep ever ran before the fetch.
      assert.equal(delayCalls, 0);
    },
  );
});

test("watch-ci final fetch detects a head that advanced right before budget expiry -> changed", async () => {
  // Head stays sha-a for every in-loop poll (all pending), then advances to sha-b
  // on the FINAL re-resolve after the budget elapses. Must report "changed", not
  // a stale-baseline timeout, so the caller re-baselines.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-watch-ci-finaladvance-"));
  try {
    const ghPath = path.join(tempDir, "gh");
    const counterPath = path.join(tempDir, "prview-counter.txt");
    await writeFile(counterPath, "0", "utf8");
    // timeoutMs 10 / interval 10 -> budget floor(10/10)+1 = 2 in-loop polls
    // (counter 0,1 -> sha-a), final re-resolve is the 3rd pr-view (counter 2 -> sha-b).
    const script = [
      "#!/usr/bin/env node",
      'const { readFileSync, writeFileSync } = require("node:fs");',
      `const counterPath = ${JSON.stringify(counterPath)};`,
      'const argv = process.argv.slice(2).join(" ");',
      'const has = (n) => argv.includes(n);',
      'if (has("pr") && has("view")) {',
      '  const i = Number(readFileSync(counterPath, "utf8").trim() || "0");',
      '  writeFileSync(counterPath, String(i + 1));',
      '  const sha = i < 2 ? "sha-a" : "sha-b";',
      '  process.stdout.write(JSON.stringify({ headRefOid: sha, statusCheckRollup: [{ name: "build" }] }));',
      '  process.exit(0);',
      '}',
      `if (has("check-runs")) { process.stdout.write(${JSON.stringify(checkRuns([{ status: "in_progress", conclusion: null, name: "build" }]))}); process.exit(0); }`,
      `if (has("/status")) { process.stdout.write(${JSON.stringify(statuses([]))}); process.exit(0); }`,
      'process.stderr.write(`unexpected gh args: ${argv}\\n`); process.exit(97);',
      "",
    ].join("\n");
    await writeFile(ghPath, script, "utf8");
    await chmod(ghPath, 0o755);
    const env = { ...process.env, PATH: [tempDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter) };
    const result = await watchCiStatus({ repo: "owner/repo", pr: 7, pollIntervalMs: 10, timeoutMs: 10 }, fastDeps(env));
    assert.equal(result.status, "changed");
    assert.equal(result.settled, false);
    assert.equal(result.headSha, "sha-b");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("watch-ci parses defaults and flags", () => {
  const defaults = parseCiWatchCliArgs(["--repo", "owner/repo", "--pr", "7"]);
  assert.equal(defaults.pollIntervalMs, 60_000);
  assert.equal(defaults.timeoutMs, 1_800_000);
  assert.equal(defaults.repo, "owner/repo");
  assert.equal(defaults.pr, 7);

  const custom = parseCiWatchCliArgs(["--repo", " owner/repo ", "--pr", "7", "--timeout-ms", "0", "--poll-interval-ms", "5000"]);
  assert.equal(custom.repo, "owner/repo");
  assert.equal(custom.timeoutMs, 0);
  assert.equal(custom.pollIntervalMs, 5000);
});

test("watch-ci rejects malformed arguments deterministically", async () => {
  const missingPr = await runNode(["--repo", "owner/repo"]);
  assert.equal(missingPr.code, 1);
  assert.match(JSON.parse(missingPr.stderr).error, /requires both --repo/i);

  const badTimeout = await runNode(["--repo", "owner/repo", "--pr", "7", "--timeout-ms", "-1"]);
  assert.equal(badTimeout.code, 1);
  assert.match(JSON.parse(badTimeout.stderr).error, /--timeout-ms must be a non-negative integer/);

  const badInterval = await runNode(["--repo", "owner/repo", "--pr", "7", "--poll-interval-ms", "0"]);
  assert.equal(badInterval.code, 1);
  assert.match(JSON.parse(badInterval.stderr).error, /--poll-interval-ms must be a positive integer/);
});

test("watch-ci --help prints usage and exits 0", async () => {
  const helpLong = await runNode(["--help"]);
  assert.equal(helpLong.code, 0);
  assert.equal(helpLong.stderr, "");
  assert(helpLong.stdout.includes("probe-ci-status.mjs"));
  assert(helpLong.stdout.includes("--repo"));
  assert(helpLong.stdout.includes("--timeout-ms"));

  const helpShort = await runNode(["-h"]);
  assert.equal(helpShort.code, 0);
  assert.equal(helpShort.stdout, helpLong.stdout);
});

// ---------------------------------------------------------------------------
// Loop-derived gate-evidence exclusion (#1531): watch-ci / probe-ci-status must
// apply the same LOOP_DERIVED_CI_CHECK_NAMES exclusion as
// detect-copilot-loop-state.mjs, so the wait never block-waits on the
// gate-evidence status/check-run the loop itself derives. Mirrors
// deriveLoopCiStatusFromRollup.
// ---------------------------------------------------------------------------
import { deriveLoopCiStatusFromRollup } from "@dev-loops/core/loop/copilot-ci-status";

test("watch-ci settles success when gate-evidence is the only pending entry (self-referential trigger, #1531)", async () => {
  // Trigger 1: the verdict needs green CI, and gate-evidence cannot go green
  // until the verdict exists. gate-evidence-runner is still in_progress; the
  // gate-evidence status is pending. Every REAL check is green. The wait must
  // settle success, not burn the budget.
  await withGhStub(
    {
      routes: [
        { match: ["pr", "view"], stdout: prView("sha-a", ["verify", "changes", "gate-evidence-runner", "gate-evidence"]) },
        { match: ["check-runs"], stdout: checkRuns([
          { status: "completed", conclusion: "success", name: "verify" },
          { status: "completed", conclusion: "success", name: "changes" },
          { status: "in_progress", conclusion: null, name: "gate-evidence-runner" },
        ]) },
        { match: ["/status"], stdout: statuses([{ state: "pending", context: "gate-evidence" }]) },
      ],
    },
    async (env) => {
      const result = await watchCiStatus({ repo: "owner/repo", pr: 7, pollIntervalMs: 10, timeoutMs: 100 }, fastDeps(env));
      assert.equal(result.status, "success");
      assert.equal(result.settled, true);
      assert.equal(result.ciStatus, "success");
      assert.deepEqual(result.failedChecks, []);
    },
  );
});

test("watch-ci settles success when gate-evidence pending on unresolved threads (trigger 2, #1584 reproduction)", async () => {
  // Trigger 2: ALL check-runs complete and green (including gate-evidence-runner),
  // gate-evidence status pending due to unresolved gate-authored threads. The
  // wait settles on real CI; thread enforcement is owned by the pre-merge
  // evidence check (#1585), not the CI wait.
  await withGhStub(
    {
      routes: [
        { match: ["pr", "view"], stdout: prView("sha-a", ["verify", "changes", "gate-evidence-runner", "gate-evidence"]) },
        { match: ["check-runs"], stdout: checkRuns([
          { status: "completed", conclusion: "success", name: "verify" },
          { status: "completed", conclusion: "success", name: "changes" },
          { status: "completed", conclusion: "success", name: "gate-evidence-runner" },
        ]) },
        { match: ["/status"], stdout: statuses([{ state: "pending", context: "gate-evidence" }]) },
      ],
    },
    async (env) => {
      const result = await watchCiStatus({ repo: "owner/repo", pr: 7, pollIntervalMs: 10, timeoutMs: 100 }, fastDeps(env));
      assert.equal(result.status, "success");
      assert.equal(result.settled, true);
      assert.equal(result.ciStatus, "success");
      assert.deepEqual(result.failedChecks, []);
    },
  );
});

test("watch-ci blocks when gate-evidence is pending AND a real check fails (exclusion does not mask failure, #1531)", async () => {
  // gate-evidence pending + a genuinely failing real check → the wait must
  // still block (failure), and the real failure must be reported in failedChecks.
  await withGhStub(
    {
      routes: [
        { match: ["pr", "view"], stdout: prView("sha-a", ["verify", "changes", "gate-evidence-runner", "gate-evidence"]) },
        { match: ["check-runs"], stdout: checkRuns([
          { status: "completed", conclusion: "failure", name: "verify" },
          { status: "completed", conclusion: "success", name: "changes" },
          { status: "completed", conclusion: "success", name: "gate-evidence-runner" },
        ]) },
        { match: ["/status"], stdout: statuses([{ state: "pending", context: "gate-evidence" }]) },
      ],
    },
    async (env) => {
      const result = await watchCiStatus({ repo: "owner/repo", pr: 7, pollIntervalMs: 10, timeoutMs: 100 }, fastDeps(env));
      assert.equal(result.status, "failure");
      assert.equal(result.settled, true);
      assert.equal(result.ciStatus, "failure");
      assert.deepEqual(result.failedChecks, [{ name: "verify" }]);
    },
  );
});

test("watch-ci: gate-evidence red alone does not mask a green run — surfaces excludedFailureDetails (#1531)", async () => {
  // gate-evidence status FAILURE + every real check green → ciStatus success
  // (the exclusion resolves it), but excludedFailureDetails lists gate-evidence
  // so a reader can tell "green apart from gate-evidence" from "green".
  await withGhStub(
    {
      routes: [
        { match: ["pr", "view"], stdout: prView("sha-a", ["verify", "changes", "gate-evidence-runner", "gate-evidence"]) },
        { match: ["check-runs"], stdout: checkRuns([
          { status: "completed", conclusion: "success", name: "verify" },
          { status: "completed", conclusion: "success", name: "changes" },
          { status: "completed", conclusion: "success", name: "gate-evidence-runner" },
        ]) },
        { match: ["/status"], stdout: statuses([{ state: "failure", context: "gate-evidence" }]) },
      ],
    },
    async (env) => {
      const result = await watchCiStatus({ repo: "owner/repo", pr: 7, pollIntervalMs: 10, timeoutMs: 100 }, fastDeps(env));
      assert.equal(result.status, "success");
      assert.equal(result.settled, true);
      assert.equal(result.ciStatus, "success");
      assert.deepEqual(result.failedChecks, []);
      assert.deepEqual(result.excludedFailureDetails, ["gate-evidence"]);
    },
  );
});

test("watch-ci: a green run with no gate-evidence entry reports empty excludedFailureDetails", async () => {
  // Plain green (no gate-evidence present) — excludedFailureDetails is empty,
  // distinct from "green apart from gate-evidence".
  await withGhStub(
    {
      routes: [
        { match: ["pr", "view"], stdout: prView("sha-a", ["verify"]) },
        { match: ["check-runs"], stdout: checkRuns([{ status: "completed", conclusion: "success", name: "verify" }]) },
        { match: ["/status"], stdout: statuses([]) },
      ],
    },
    async (env) => {
      const result = await watchCiStatus({ repo: "owner/repo", pr: 7, pollIntervalMs: 10, timeoutMs: 100 }, fastDeps(env));
      assert.equal(result.status, "success");
      assert.deepEqual(result.excludedFailureDetails, []);
    },
  );
});

test("watch-ci: a failing gate-evidence-runner check-run is excluded, not in failedChecks (#1531)", async () => {
  // gate-evidence-runner FAILURE + real checks green → ciStatus success, and the
  // runner does NOT appear in failedChecks (it is excluded as loop-derived).
  await withGhStub(
    {
      routes: [
        { match: ["pr", "view"], stdout: prView("sha-a", ["verify", "gate-evidence-runner", "gate-evidence"]) },
        { match: ["check-runs"], stdout: checkRuns([
          { status: "completed", conclusion: "success", name: "verify" },
          { status: "completed", conclusion: "failure", name: "gate-evidence-runner" },
        ]) },
        { match: ["/status"], stdout: statuses([{ state: "pending", context: "gate-evidence" }]) },
      ],
    },
    async (env) => {
      const result = await watchCiStatus({ repo: "owner/repo", pr: 7, pollIntervalMs: 10, timeoutMs: 100 }, fastDeps(env));
      assert.equal(result.status, "success");
      assert.equal(result.ciStatus, "success");
      assert.deepEqual(result.failedChecks, []);
      assert.deepEqual(result.excludedFailureDetails, ["gate-evidence"]);
    },
  );
});

test("the prober and the detector agree on one rollup fixture (#1531)", async () => {
  // One fixture expressed in both statusCheckRollup form (for the detector's
  // deriveLoopCiStatusFromRollup) and check-runs + commit-status form (for the
  // prober's watchCiStatus). The two must derive the same status — they cannot
  // disagree about whether the loop may proceed.
  const fixture = {
    rollup: [
      { __typename: "CheckRun", name: "verify", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", name: "changes", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", name: "gate-evidence-runner", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "StatusContext", context: "gate-evidence", state: "PENDING" },
    ],
    checkRuns: [
      { status: "completed", conclusion: "success", name: "verify" },
      { status: "completed", conclusion: "success", name: "changes" },
      { status: "completed", conclusion: "success", name: "gate-evidence-runner" },
    ],
    statuses: [{ state: "pending", context: "gate-evidence" }],
  };

  const derivation = deriveLoopCiStatusFromRollup(fixture.rollup);

  await withGhStub(
    {
      routes: [
        { match: ["pr", "view"], stdout: prView("sha-a", ["verify", "changes", "gate-evidence-runner", "gate-evidence"]) },
        { match: ["check-runs"], stdout: checkRuns(fixture.checkRuns) },
        { match: ["/status"], stdout: statuses(fixture.statuses) },
      ],
    },
    async (env) => {
      const result = await watchCiStatus({ repo: "owner/repo", pr: 7, pollIntervalMs: 10, timeoutMs: 0 }, fastDeps(env));
      // The prober's ciStatus must match the detector's derived status.
      assert.equal(result.ciStatus, derivation.status,
        `prober ciStatus "${result.ciStatus}" must match detector status "${derivation.status}"`);
      assert.equal(result.ciStatus, "success");
    },
  );
});

test("the prober and the detector agree on a failing-check fixture (#1531)", async () => {
  // Same agreement, but with a real failure beside gate-evidence pending: both
  // must report failure so the loop does not proceed on a red check.
  const fixture = {
    rollup: [
      { __typename: "CheckRun", name: "verify", status: "COMPLETED", conclusion: "FAILURE" },
      { __typename: "CheckRun", name: "changes", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "StatusContext", context: "gate-evidence", state: "PENDING" },
    ],
    checkRuns: [
      { status: "completed", conclusion: "failure", name: "verify" },
      { status: "completed", conclusion: "success", name: "changes" },
    ],
    statuses: [{ state: "pending", context: "gate-evidence" }],
  };

  const derivation = deriveLoopCiStatusFromRollup(fixture.rollup);

  await withGhStub(
    {
      routes: [
        { match: ["pr", "view"], stdout: prView("sha-a", ["verify", "changes", "gate-evidence"]) },
        { match: ["check-runs"], stdout: checkRuns(fixture.checkRuns) },
        { match: ["/status"], stdout: statuses(fixture.statuses) },
      ],
    },
    async (env) => {
      const result = await watchCiStatus({ repo: "owner/repo", pr: 7, pollIntervalMs: 10, timeoutMs: 0 }, fastDeps(env));
      assert.equal(result.ciStatus, derivation.status,
        `prober ciStatus "${result.ciStatus}" must match detector status "${derivation.status}"`);
      assert.equal(result.ciStatus, "failure");
    },
  );
});
