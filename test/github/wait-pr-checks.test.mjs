import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { runNode as runNodeHelper } from "../_helpers.mjs";

import { exitCodeForWaitResult, parseWaitPrChecksCliArgs, runCli } from "../../scripts/github/wait-pr-checks.mjs";

const scriptPath = path.resolve("scripts/github/wait-pr-checks.mjs");
const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

function prView(headSha, checkNames = []) {
  return JSON.stringify({ headRefOid: headSha, statusCheckRollup: checkNames.map((name) => ({ name })) });
}
function checkRuns(runs) {
  return JSON.stringify({ check_runs: runs });
}
function statuses(items) {
  return JSON.stringify({ statuses: items });
}

// Router-style gh stub (matches each call's args against a rule and returns its
// stdout), mirroring probe-ci-status.test.mjs's harness: repeatable across
// polls and safe under the concurrent check-runs/status Promise.all calls
// inside watchCiStatus.
async function withGhStub(routes, fn) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-wait-pr-checks-"));
  try {
    const ghPath = path.join(tempDir, "gh");
    const script = [
      "#!/usr/bin/env node",
      `const routes = ${JSON.stringify(routes)};`,
      'const argv = process.argv.slice(2).join(" ");',
      'function match(needles) { return needles.every((n) => argv.includes(n)); }',
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

function makeStream() {
  const chunks = [];
  return { write: (s) => { chunks.push(s); }, text: () => chunks.join("") };
}

const fastDeps = (env) => ({ env, ghCommand: "gh", delayImpl: async () => {}, now: () => 1_000 });

test("wait-pr-checks exits 0 with status success when all checks pass", async () => {
  await withGhStub(
    [
      { match: ["pr", "view"], stdout: prView("sha-a", ["build"]) },
      { match: ["check-runs"], stdout: checkRuns([{ status: "completed", conclusion: "success", name: "build" }]) },
      { match: ["/status"], stdout: statuses([]) },
    ],
    async (env) => {
      const stdout = makeStream();
      const stderr = makeStream();
      const code = await runCli(["--repo", "owner/repo", "--pr", "7", "--poll", "1", "--timeout", "5"], { stdout, stderr, ...fastDeps(env) });
      assert.equal(code, 0);
      const result = JSON.parse(stdout.text());
      assert.equal(result.status, "success");
      assert.equal(result.settled, true);
      assert.deepEqual(result.failedChecks, []);
    },
  );
});

test("wait-pr-checks exits 1 immediately with status failure when a check fails", async () => {
  await withGhStub(
    [
      { match: ["pr", "view"], stdout: prView("sha-a", ["lint"]) },
      { match: ["check-runs"], stdout: checkRuns([{ status: "completed", conclusion: "failure", name: "lint" }]) },
      { match: ["/status"], stdout: statuses([]) },
    ],
    async (env) => {
      const stdout = makeStream();
      const stderr = makeStream();
      const code = await runCli(["--repo", "owner/repo", "--pr", "7", "--poll", "1", "--timeout", "5"], { stdout, stderr, ...fastDeps(env) });
      assert.equal(code, 1);
      const result = JSON.parse(stdout.text());
      assert.equal(result.status, "failure");
      assert.deepEqual(result.failedChecks, [{ name: "lint" }]);
    },
  );
});

test("wait-pr-checks exits 2 when CI stays pending past the wait budget (timeout)", async () => {
  await withGhStub(
    [
      { match: ["pr", "view"], stdout: prView("sha-a", ["build"]) },
      { match: ["check-runs"], stdout: checkRuns([{ status: "in_progress", conclusion: null, name: "build" }]) },
      { match: ["/status"], stdout: statuses([]) },
    ],
    async (env) => {
      const stdout = makeStream();
      const stderr = makeStream();
      const code = await runCli(["--repo", "owner/repo", "--pr", "7", "--poll", "1", "--timeout", "2"], { stdout, stderr, ...fastDeps(env) });
      assert.equal(code, 2);
      const result = JSON.parse(stdout.text());
      assert.equal(result.status, "timeout");
      assert.equal(result.settled, false);
    },
  );
});

test("wait-pr-checks does not fabricate green on a lone zero-registered-checks poll (grace race guard)", async () => {
  // Genuinely check-less head (empty rollup, zero check-runs/statuses): must NOT
  // settle green on the first poll, only after the inherited grace window.
  await withGhStub(
    [
      { match: ["pr", "view"], stdout: prView("sha-a", []) },
      { match: ["check-runs"], stdout: checkRuns([]) },
      { match: ["/status"], stdout: statuses([]) },
    ],
    async (env) => {
      const stdout = makeStream();
      const stderr = makeStream();
      const code = await runCli(["--repo", "owner/repo", "--pr", "7", "--poll", "1", "--timeout", "5"], { stdout, stderr, ...fastDeps(env) });
      const result = JSON.parse(stdout.text());
      assert.equal(code, 0);
      assert.equal(result.status, "success");
      assert.equal(result.ciStatus, "none");
      assert.equal(result.attempts, 2); // grace: not the first poll — the race guard held
    },
  );
});

test("wait-pr-checks --jq extracts a field and exits per the standard jq-output contract", async () => {
  await withGhStub(
    [
      { match: ["pr", "view"], stdout: prView("sha-a", ["build"]) },
      { match: ["check-runs"], stdout: checkRuns([{ status: "completed", conclusion: "success", name: "build" }]) },
      { match: ["/status"], stdout: statuses([]) },
    ],
    async (env) => {
      const stdout = makeStream();
      const stderr = makeStream();
      const code = await runCli(["--repo", "owner/repo", "--pr", "7", "--poll", "1", "--timeout", "5", "--jq", ".status"], { stdout, stderr, ...fastDeps(env) });
      assert.equal(code, 0);
      assert.equal(stdout.text(), "success\n");
    },
  );
});

// Generic --silent success mapping is owned by emitResult
// (test/loop/jq-output.test.mjs); the positive --jq wiring case above plus the
// command-specific status->exit mapping below are what remain distinct here.

test("exitCodeForWaitResult maps status to the documented exit codes", () => {
  assert.equal(exitCodeForWaitResult({ status: "success" }), 0);
  assert.equal(exitCodeForWaitResult({ status: "failure" }), 1);
  assert.equal(exitCodeForWaitResult({ status: "timeout" }), 2);
  assert.equal(exitCodeForWaitResult({ status: "changed" }), 2);
  assert.equal(exitCodeForWaitResult({ status: "pending" }), 2);
  assert.equal(exitCodeForWaitResult({ status: "stuck" }), 2);
});

test("wait-pr-checks parses --timeout/--poll in seconds into ms, with policy-derived defaults", () => {
  const defaults = parseWaitPrChecksCliArgs(["--repo", "owner/repo", "--pr", "7"]);
  assert.equal(defaults.timeoutMs, 1_800_000);
  assert.equal(defaults.pollIntervalMs, 60_000);

  const custom = parseWaitPrChecksCliArgs(["--repo", "owner/repo", "--pr", "7", "--timeout", "0", "--poll", "5"]);
  assert.equal(custom.timeoutMs, 0);
  assert.equal(custom.pollIntervalMs, 5_000);
});

test("wait-pr-checks rejects malformed arguments deterministically", async () => {
  const missingPr = await runNode(["--repo", "owner/repo"]);
  assert.equal(missingPr.code, 1);
  assert.match(JSON.parse(missingPr.stderr).error, /requires both --repo/i);

  const badTimeout = await runNode(["--repo", "owner/repo", "--pr", "7", "--timeout", "-1"]);
  assert.equal(badTimeout.code, 1);
  assert.match(JSON.parse(badTimeout.stderr).error, /--timeout must be a non-negative integer/);

  const badPoll = await runNode(["--repo", "owner/repo", "--pr", "7", "--poll", "0"]);
  assert.equal(badPoll.code, 1);
  assert.match(JSON.parse(badPoll.stderr).error, /--poll must be a positive integer/);

  // Canonical digits only: JS-coercible spellings (1e3, hex, decimals) are rejected.
  for (const nonCanonical of ["1e3", "0x10", "1.0"]) {
    const badSpelling = await runNode(["--repo", "owner/repo", "--pr", "7", "--timeout", nonCanonical]);
    assert.equal(badSpelling.code, 1, `--timeout ${nonCanonical} must be rejected`);
    assert.match(JSON.parse(badSpelling.stderr).error, /--timeout must be a non-negative integer/);
  }
});

test("wait-pr-checks --help prints usage and exits 0", async () => {
  const result = await runNode(["--help"]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert(result.stdout.includes("wait-pr-checks.mjs"));
  assert(result.stdout.includes("--timeout"));
  assert(result.stdout.includes("--poll"));
  // USAGE must match the actual exit-code behavior: argument/gh/runtime errors
  // exit 1 (repo convention, asserted above), exit 2 is not-settled only.
  assert(result.stdout.includes('1  Red (status "failure"), or an argument/gh/runtime error'));
  assert(result.stdout.includes('2  Not settled (status "timeout"/"changed"/"pending"/"stuck")'));
});

// In-process runChild fake: the first `pr view` hits the GraphQL rate limit,
// later calls succeed; `api rate_limit` reports the graphql reset.
function rateLimitedRunChild(resetEpochSeconds, { noChecks = false } = {}) {
  const calls = [];
  let prViews = 0;
  const runChild = async (_command, args) => {
    const argv = args.join(" ");
    calls.push(argv);
    if (argv === "api rate_limit") {
      return { code: 0, stdout: JSON.stringify({ resources: { graphql: { remaining: 0, reset: resetEpochSeconds } } }), stderr: "" };
    }
    if (argv.startsWith("pr view")) {
      prViews += 1;
      if (prViews === 1) return { code: 1, stdout: "", stderr: "GraphQL: API rate limit exceeded for user ID 1." };
      return { code: 0, stdout: prView("sha-a", noChecks ? [] : ["build"]), stderr: "" };
    }
    if (argv.includes("check-runs")) {
      return { code: 0, stdout: checkRuns(noChecks ? [] : [{ status: "completed", conclusion: "success", name: "build" }]), stderr: "" };
    }
    if (argv.includes("/status")) return { code: 0, stdout: statuses([]), stderr: "" };
    return { code: 97, stdout: "", stderr: `unexpected gh args: ${argv}` };
  };
  return { runChild, calls };
}

test("wait-pr-checks waits for the GraphQL reset inside its --timeout budget, heartbeating, then settles success", async () => {
  let clock = 1_000_000_000_000;
  const delays = [];
  const delayImpl = async (ms) => { delays.push(ms); clock += ms; };
  const { runChild, calls } = rateLimitedRunChild(clock / 1000 + 100);
  const heartbeats = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => { heartbeats.push(String(chunk)); return true; };
  const stdout = makeStream();
  let code;
  try {
    code = await runCli(["--repo", "owner/repo", "--pr", "7", "--poll", "1", "--timeout", "300"], {
      stdout, stderr: makeStream(), env: {}, runChild, delayImpl, now: () => clock,
    });
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout.text()).status, "success");
  assert.equal(calls.filter((c) => c === "api rate_limit").length, 1);
  assert.deepEqual(delays.slice(0, 3), [45_000, 45_000, 10_000]);
  const watchHeartbeats = heartbeats.map((line) => JSON.parse(line)).filter((line) => line.type === "watch_heartbeat");
  assert.equal(watchHeartbeats.length, 2);
});

test("wait-pr-checks returns RATE_LIMITED with resetAt, without sleeping, when the reset is past the remaining budget", async () => {
  const clock = 1_000_000_000_000;
  const delays = [];
  const reset = clock / 1000 + 120;
  const { runChild } = rateLimitedRunChild(reset);
  const stdout = makeStream();
  const code = await runCli(["--repo", "owner/repo", "--pr", "7", "--poll", "1", "--timeout", "60"], {
    stdout, stderr: makeStream(), env: {}, runChild, delayImpl: async (ms) => { delays.push(ms); }, now: () => clock,
  });
  assert.equal(code, 1);
  const result = JSON.parse(stdout.text());
  assert.equal(result.ok, false);
  assert.equal(result.code, "RATE_LIMITED");
  assert.equal(result.resetAt, new Date(reset * 1000).toISOString());
  assert.deepEqual(delays, []);
});

test("wait-pr-checks refreshes the runner lease while it waits for the GraphQL reset", async () => {
  let clock = 1_000_000_000_000;
  const { runChild } = rateLimitedRunChild(clock / 1000 + 100);
  const leaseCalls = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = () => true;
  let code;
  try {
    code = await runCli(["--repo", "owner/repo", "--pr", "7", "--poll", "1", "--timeout", "300"], {
      stdout: makeStream(), stderr: makeStream(), env: {}, runChild,
      delayImpl: async (ms) => { clock += ms; },
      now: () => clock,
      ensureOwnershipImpl: async (args) => { leaseCalls.push(args); return { ok: true, status: "owner_confirmed" }; },
    });
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(code, 0);
  // Two heartbeats fall inside the 100s reset wait; the retry settles on its first poll.
  assert.equal(leaseCalls.length, 2);
  assert.equal(leaseCalls[0].repo, "owner/repo");
  assert.equal(leaseCalls[0].pr, 7);
  assert.equal(leaseCalls[0].claimIfMissing, true);
  assert.equal(leaseCalls[0].requireExisting, false);
});

test("wait-pr-checks keeps the no-checks grace floor when the reset consumes the whole budget", async () => {
  let clock = 1_000_000_000_000;
  const { runChild } = rateLimitedRunChild(clock / 1000 + 300, { noChecks: true });
  const originalWrite = process.stderr.write;
  process.stderr.write = () => true;
  const stdout = makeStream();
  let code;
  try {
    code = await runCli(["--repo", "owner/repo", "--pr", "7", "--poll", "1", "--timeout", "300"], {
      stdout, stderr: makeStream(), env: {}, runChild,
      delayImpl: async (ms) => { clock += ms; },
      now: () => clock,
      ensureOwnershipImpl: async () => ({ ok: true }),
    });
  } finally {
    process.stderr.write = originalWrite;
  }
  const result = JSON.parse(stdout.text());
  assert.notEqual(result.status, "success");
  assert.equal(result.settled, false);
  assert.equal(code, 2);
});

test("wait-pr-checks --help names the RATE_LIMITED result and its resetAt field", async () => {
  const stdout = makeStream();
  assert.equal(await runCli(["--help"], { stdout }), 0);
  assert(stdout.text().includes("RATE_LIMITED"));
  assert(stdout.text().includes("resetAt"));
});
