import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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

test("wait-pr-checks --silent suppresses stdout and maps success -> 0", async () => {
  await withGhStub(
    [
      { match: ["pr", "view"], stdout: prView("sha-a", ["build"]) },
      { match: ["check-runs"], stdout: checkRuns([{ status: "completed", conclusion: "success", name: "build" }]) },
      { match: ["/status"], stdout: statuses([]) },
    ],
    async (env) => {
      const stdout = makeStream();
      const stderr = makeStream();
      const code = await runCli(["--repo", "owner/repo", "--pr", "7", "--poll", "1", "--timeout", "5", "--silent"], { stdout, stderr, ...fastDeps(env) });
      assert.equal(code, 0);
      assert.equal(stdout.text(), "");
    },
  );
});

test("exitCodeForWaitResult maps status to the documented exit codes", () => {
  assert.equal(exitCodeForWaitResult({ status: "success" }), 0);
  assert.equal(exitCodeForWaitResult({ status: "failure" }), 1);
  assert.equal(exitCodeForWaitResult({ status: "timeout" }), 2);
  assert.equal(exitCodeForWaitResult({ status: "changed" }), 2);
  assert.equal(exitCodeForWaitResult({ status: "pending" }), 2);
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
  assert(result.stdout.includes('2  Not settled (status "timeout"/"changed"/"pending")'));
});
