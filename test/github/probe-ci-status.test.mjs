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
