import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { test } from "bun:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";

import { checkBaseFreshness, parseRemoteFreshnessGuardCliArgs, runCli } from "../../scripts/loop/pre-write-remote-freshness-guard.mjs";

const scriptPath = path.resolve("scripts/loop/pre-write-remote-freshness-guard.mjs");

const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

async function writeGitStub(tempDir, { commits = [], logFile } = {}) {
  const gitPath = path.join(tempDir, "git");
  const commitOutput = commits.length > 0 ? `${commits.join("\n")}\n` : "";

  await writeFile(
    gitPath,
    [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const joined = args.join(' ');",
      "if (process.env.FRESHNESS_GUARD_LOG_FILE) {",
      "  appendFileSync(process.env.FRESHNESS_GUARD_LOG_FILE, `${joined}\\n`);",
      "}",
      "if (args[0] === 'fetch' && args[1] === 'origin' && typeof args[2] === 'string') {",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'log' && typeof args[1] === 'string' && args[2] === '--oneline') {",
      `  process.stdout.write(${JSON.stringify(commitOutput)});`,
      "  process.exit(0);",
      "}",
      "process.stderr.write(`unexpected git args: ${joined}\\n`);",
      "process.exit(1);",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(gitPath, 0o755);

  return {
    ...process.env,
    FRESHNESS_GUARD_LOG_FILE: logFile,
    PATH: `${tempDir}${path.delimiter}${process.env.PATH}`,
  };
}

test("parseRemoteFreshnessGuardCliArgs rejects missing --branch", () => {
  assert.throws(() => parseRemoteFreshnessGuardCliArgs([]), /--branch .* is required/i);
});

test("parseRemoteFreshnessGuardCliArgs parses --branch", () => {
  const options = parseRemoteFreshnessGuardCliArgs(["--branch", "copilot/a"]);
  assert.equal(options.branch, "copilot/a");
  assert.equal(options.help, false);
});

test("freshness guard exits 0 when remote branch is up to date", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "freshness-guard-test-"));
  const logFile = path.join(tempDir, "git.log");

  try {
    const env = await writeGitStub(tempDir, { commits: [], logFile });
    const result = await runNode(["--branch", "copilot/expected"], { env });

    assert.equal(result.code, 0, `expected exit 0, got stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim());
    assert.deepEqual(parsed, { ok: true, status: "up_to_date" });

    const gitLog = await readFile(logFile, "utf8");
    assert.equal(gitLog.trim(), "fetch origin copilot/expected\nlog HEAD..origin/copilot/expected --oneline".trim());
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("freshness guard exits non-zero with remote_ahead commits list", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "freshness-guard-test-"));
  const logFile = path.join(tempDir, "git.log");

  try {
    const env = await writeGitStub(tempDir, {
      commits: ["abc1234 add guard", "def5678 fix tests"],
      logFile,
    });
    const result = await runNode(["--branch", "copilot/expected"], { env });

    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stderr.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, "remote_ahead");
    assert.deepEqual(parsed.newCommits, ["abc1234 add guard", "def5678 fix tests"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("freshness guard exits non-zero with usage when --branch is missing", async () => {
  const result = await runNode([]);
  assert.equal(result.code, 1);

  const parsed = JSON.parse(result.stderr.trim());
  assert.equal(parsed.ok, false);
  assert.ok(/required/i.test(parsed.error));
  assert.equal(parsed.hint, "run with --help for usage");
});

test("parseRemoteFreshnessGuardCliArgs --help returns help flag", () => {
  const options = parseRemoteFreshnessGuardCliArgs(["--help"]);
  assert.equal(options.help, true);
});

test("parseRemoteFreshnessGuardCliArgs -h returns help flag", () => {
  const options = parseRemoteFreshnessGuardCliArgs(["-h"]);
  assert.equal(options.help, true);
});

test("parseRemoteFreshnessGuardCliArgs rejects unknown argument", () => {
  assert.throws(() => parseRemoteFreshnessGuardCliArgs(["--unknown-flag"]), /Unknown argument/i);
});

test("parseRemoteFreshnessGuardCliArgs rejects flag-like value for --branch", () => {
  assert.throws(
    () => parseRemoteFreshnessGuardCliArgs(["--branch", "--other-flag"]),
    /Missing value for --branch/i,
  );
});

test("freshness guard exits 0 and prints usage with --help", async () => {
  const result = await runNode(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /--branch/);
});

test("freshness guard exits 0 and prints usage with -h", async () => {
  const result = await runNode(["-h"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /--branch/);
});

test("freshness guard exits non-zero with structured error for unknown argument", async () => {
  const result = await runNode(["--unexpected-arg"]);
  assert.equal(result.code, 1);
  const parsed = JSON.parse(result.stderr.trim());
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /Unknown argument/i);
});

test("freshness guard runCli rejects when git command does not exist (ENOENT)", async () => {
  const out = { write: () => {} };
  const err = { write: () => {} };

  await assert.rejects(
    () =>
      runCli(["--branch", "main"], {
        stdout: out,
        stderr: err,
        gitCommand: "this-binary-does-not-exist-xyz",
      }),
    (e) => {
      assert.ok(e instanceof Error);
      return true;
    },
  );
});

test("freshness guard runCli rejects when git exits non-zero with empty stderr", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "freshness-guard-err-"));
  try {
    const gitPath = path.join(tempDir, "git");
    await writeFile(
      gitPath,
      [
        "#!/usr/bin/env node",
        "process.exit(2);",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(gitPath, 0o755);
    const env = { ...process.env, PATH: `${tempDir}${path.delimiter}${process.env.PATH}` };
    const out = { write: () => {} };
    const err = { write: () => {} };

    await assert.rejects(
      () => runCli(["--branch", "main"], { stdout: out, stderr: err, env }),
      (e) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /exited with code/i);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("parseRemoteFreshnessGuardCliArgs rejects single-dash flag-like value for --branch", () => {
  assert.throws(
    () => parseRemoteFreshnessGuardCliArgs(["--branch", "-x"]),
    /Missing value for --branch/i,
  );
});

// Issue 2885: real throwaway repos with a bare origin; origin/main advances after the branch forked.
async function makeStaleBaseFixture({ advance }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "freshness-base-"));
  const g = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const origin = path.join(root, "origin.git");
  const other = path.join(root, "other");
  const clone = path.join(root, "clone");
  g(root, ["init", "-q", "--bare", "-b", "main", origin]);
  g(root, ["clone", "-q", origin, other]);
  for (const dir of [other]) { g(dir, ["config", "user.email", "t@example.com"]); g(dir, ["config", "user.name", "t"]); }
  await writeFile(path.join(other, "a.txt"), "a\n");
  g(other, ["add", "a.txt"]);
  g(other, ["commit", "-qm", "init"]);
  g(other, ["push", "-q", "origin", "main"]);
  g(root, ["clone", "-q", origin, clone]);
  g(clone, ["config", "user.email", "t@example.com"]);
  g(clone, ["config", "user.name", "t"]);
  g(clone, ["checkout", "-q", "-b", "feature"]);
  await writeFile(path.join(clone, "b.txt"), "b\n");
  g(clone, ["add", "b.txt"]);
  g(clone, ["commit", "-qm", "feature"]);
  if (advance) {
    await writeFile(path.join(other, "c.txt"), "c\n");
    g(other, ["add", "c.txt"]);
    g(other, ["commit", "-qm", "newer base commit"]);
    g(other, ["push", "-q", "origin", "main"]);
  }
  return { root, clone };
}

test("checkBaseFreshness passes with no warning when the branch contains origin/<base>", async () => {
  const { root, clone } = await makeStaleBaseFixture({ advance: false });
  try {
    assert.deepEqual(await checkBaseFreshness({ base: "main", cwd: clone }), { ok: true, status: "base_current", base: "main" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkBaseFreshness refuses a behind-base branch, names the newer commit and the foreign file", async () => {
  const { root, clone } = await makeStaleBaseFixture({ advance: true });
  try {
    const result = await checkBaseFreshness({ base: "main", cwd: clone });
    assert.equal(result.ok, false);
    assert.equal(result.error, "base_stale_integrate_first");
    assert.equal(result.newerCommits.length, 1);
    assert.match(result.newerCommits[0], /newer base commit/u);
    // c.txt differs from origin/main two-dot but the branch never touched it.
    assert.deepEqual(result.foreignFiles, ["c.txt"]);
    assert.match(result.remedy, /resolve-pr-conflicts\.mjs/u);
    assert.match(result.remedy, /Never force-push/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCli --base exits nonzero when stale and rejects a call with neither --branch nor --base", async () => {
  const { root, clone } = await makeStaleBaseFixture({ advance: true });
  try {
    const sink = { write: () => {} };
    const saved = process.exitCode;
    const result = await runCli(["--base", "main"], { stdout: sink, stderr: sink, cwd: clone });
    assert.equal(result.error, "base_stale_integrate_first");
    assert.equal(process.exitCode, 1);
    process.exitCode = saved;
    assert.throws(() => parseRemoteFreshnessGuardCliArgs([]), /--branch <name> is required/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
