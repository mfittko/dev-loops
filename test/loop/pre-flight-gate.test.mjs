import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

import { parsePreFlightGateCliArgs, runCli } from "../../scripts/loop/pre-flight-gate.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a fake git script as a shell script that writes its arguments
 * to a log file and optionally emits configured stdout/stderr/exit code.
 */
function writeGitStub(tempDir, {
  branch = null,
  worktreeListOut = null,
  exitCode = 0,
  logFile,
} = {}) {
  const gitPath = path.join(tempDir, "git");
  const lines = ["#!/usr/bin/env sh"];
  lines.push(`echo "$@" >> ${JSON.stringify(logFile)}`);

  if (branch !== null) {
    lines.push(`echo ${JSON.stringify(branch)}`);
    lines.push(`exit ${exitCode}`);
  } else if (worktreeListOut !== null) {
    lines.push(`cat <<'WTEOF'`);
    lines.push(...worktreeListOut.split("\n"));
    lines.push("WTEOF");
    lines.push(`exit ${exitCode}`);
  } else {
    lines.push(`exit ${exitCode}`);
  }

  writeFileSync(gitPath, lines.join("\n"), { mode: 0o755 });
  return gitPath;
}

async function runGate(args = [], { cwd, env = {}, gitDir } = {}) {
  // Run the CLI in-process (no node subprocess per test) while keeping the real
  // git boundary: the shell git stub at `<gitDir|cwd>/git` is still spawned via
  // execFileSync inside the gate, so the git-command contract stays under test.
  const gitCommand = path.join(gitDir ?? cwd, "git");
  const fullEnv = { ...process.env, ...env };
  let outBuf = "";
  let errBuf = "";
  const collect = (bucket) => ({
    write: (chunk) => {
      if (bucket === "out") outBuf += String(chunk);
      else errBuf += String(chunk);
      return true;
    },
  });
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    await runCli(args, {
      cwd,
      env: fullEnv,
      gitCommand,
      stdout: collect("out"),
      stderr: collect("err"),
    });
    return { exitCode: process.exitCode ?? 0, stdout: outBuf.trim(), stderr: errBuf.trim() };
  } finally {
    process.exitCode = previousExitCode;
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

test("parsePreFlightGateCliArgs: parses --expected-branch", () => {
  const opts = parsePreFlightGateCliArgs(["--expected-branch", "my-branch"]);
  assert.equal(opts.expectedBranch, "my-branch");
  assert.equal(opts.checkSubagents, false);
});

test("parsePreFlightGateCliArgs: parses --check-subagents", () => {
  const opts = parsePreFlightGateCliArgs(["--check-subagents"]);
  assert.equal(opts.checkSubagents, true);
});

test("parsePreFlightGateCliArgs: parses both flags", () => {
  const opts = parsePreFlightGateCliArgs(["--expected-branch", "br", "--check-subagents"]);
  assert.equal(opts.expectedBranch, "br");
  assert.equal(opts.checkSubagents, true);
});

test("parsePreFlightGateCliArgs: no flags", () => {
  const opts = parsePreFlightGateCliArgs([]);
  assert.equal(opts.expectedBranch, undefined);
  assert.equal(opts.checkSubagents, false);
});

test("parsePreFlightGateCliArgs: --help", () => {
  const opts = parsePreFlightGateCliArgs(["--help"]);
  assert.equal(opts.help, true);
});

test("parsePreFlightGateCliArgs: -h", () => {
  const opts = parsePreFlightGateCliArgs(["-h"]);
  assert.equal(opts.help, true);
});

test("parsePreFlightGateCliArgs: rejects unknown argument", () => {
  assert.throws(
    () => parsePreFlightGateCliArgs(["--unknown"]),
    /Unknown argument: --unknown/i,
  );
});

test("parsePreFlightGateCliArgs: rejects --expected-branch with missing value", () => {
  assert.throws(
    () => parsePreFlightGateCliArgs(["--expected-branch"]),
    /Missing value for --expected-branch/i,
  );
});

// ---------------------------------------------------------------------------
// Bypass
// ---------------------------------------------------------------------------

test("gate passes with DEVLOOPS_PREFLIGHT_BYPASS=1 from main checkout", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "preflight-bypass-"));
  try {
    const result = await runGate([], {
      cwd: tempDir,
      env: { DEVLOOPS_PREFLIGHT_BYPASS: "1" },
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.checks.worktree, true);
    assert.equal(payload.summary.includes("bypassed"), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Worktree isolation: pass
// ---------------------------------------------------------------------------

test("gate passes when cwd is under tmp/worktrees/", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "preflight-worktree-ok-"));
  try {
    const worktreeDir = path.join(tempDir, "tmp", "worktrees", "issue-497");
    mkdirSync(worktreeDir, { recursive: true });

    const logFile = path.join(tempDir, "git.log");
    const worktreeListOut = [
      `${realpathSync(tempDir)}  535a18a [main]`,
      `${realpathSync(worktreeDir)}  535a18a [issue-497]`,
    ].join("\n");

    writeGitStub(tempDir, { worktreeListOut, logFile });

    const result = await runGate([], { cwd: worktreeDir, gitDir: tempDir });

    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.checks.worktree, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Worktree isolation: fail
// ---------------------------------------------------------------------------

test("gate fails when cwd is main checkout (detects main_checkout_detected)", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "preflight-main-fail-"));
  try {
    const logFile = path.join(tempDir, "git.log");
    const worktreeListOut = `${realpathSync(tempDir)}  535a18a [main]`;

    writeGitStub(tempDir, { worktreeListOut, logFile });

    const result = await runGate([], { cwd: tempDir });

    assert.equal(result.exitCode, 1);
    assert.ok(result.stderr.length > 0, "stderr should have content");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "main_checkout_detected");
    assert.ok(payload.guidance.includes("main git checkout"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("gate fails when cwd is main checkout with main-checkout-detected error (under main)", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "preflight-main-subdir-"));
  try {
    const subDir = path.join(tempDir, "src");
    mkdirSync(subDir, { recursive: true });

    const logFile = path.join(tempDir, "git.log");
    const worktreeListOut = `${realpathSync(tempDir)}  535a18a [main]`;

    writeGitStub(tempDir, { worktreeListOut, logFile });

    const result = await runGate([], { cwd: subDir, gitDir: tempDir });

    assert.equal(result.exitCode, 1);
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.ok(
      payload.error === "not_in_worktree" || payload.error === "main_checkout_detected",
      `expected not_in_worktree or main_checkout_detected, got ${payload.error}`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("gate fails when git worktree list fails", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "preflight-git-fail-"));
  try {
    const gitPath = path.join(tempDir, "git");
    writeFileSync(gitPath, "#!/usr/bin/env sh\nexit 1\n", { mode: 0o755 });

    const result = await runGate([], { cwd: tempDir });

    assert.equal(result.exitCode, 1);
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "worktree_list_failed");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("gate fails when cwd is under tmp/worktrees/ but not a real git worktree", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "preflight-fake-worktree-"));
  try {
    const fakeWorktreeDir = path.join(tempDir, "tmp", "worktrees", "fake-issue");
    mkdirSync(fakeWorktreeDir, { recursive: true });

    const logFile = path.join(tempDir, "git.log");
    const worktreeListOut = realpathSync(tempDir) + "  535a18a [main]";

    writeGitStub(tempDir, { worktreeListOut, logFile });

    const result = await runGate([], { cwd: fakeWorktreeDir, gitDir: tempDir });

    assert.equal(result.exitCode, 1);
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "not_in_worktree");
    assert.ok(
      payload.guidance.includes("not a real git worktree"),
      "guidance should mention not a real worktree",
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Branch identity
// ---------------------------------------------------------------------------

test("gate passes when --expected-branch matches current branch", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "preflight-branch-ok-"));
  try {
    const worktreeDir = path.join(tempDir, "tmp", "worktrees", "issue-497");
    mkdirSync(worktreeDir, { recursive: true });

    const logFile = path.join(tempDir, "git.log");
    const worktreeListOut = [
      `${realpathSync(tempDir)}  535a18a [main]`,
      `${realpathSync(worktreeDir)}  535a18a [issue-497]`,
    ].join("\n");

    writeGitStub(tempDir, { worktreeListOut, logFile });
    // Overwrite with branch-aware stub
    const gitPath = path.join(tempDir, "git");
    const lines = [
      "#!/usr/bin/env sh",
      `echo "$@" >> ${JSON.stringify(logFile)}`,
      'if [ "$1" = "worktree" ]; then',
      `  cat <<'WTEOF'`,
      ...worktreeListOut.split("\n"),
      "WTEOF",
      'elif [ "$1" = "branch" ]; then',
      '  echo "issue-497"',
      "fi",
      "exit 0",
    ];
    writeFileSync(gitPath, lines.join("\n"), { mode: 0o755 });

    const result = await runGate(["--expected-branch", "issue-497"], { cwd: worktreeDir, gitDir: tempDir });

    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.checks.branch, "matched");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("gate fails when --expected-branch does not match current branch", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "preflight-branch-mismatch-"));
  try {
    const worktreeDir = path.join(tempDir, "tmp", "worktrees", "issue-497");
    mkdirSync(worktreeDir, { recursive: true });

    const logFile = path.join(tempDir, "git.log");
    const worktreeListOut = [
      `${realpathSync(tempDir)}  535a18a [main]`,
      `${realpathSync(worktreeDir)}  535a18a [issue-497]`,
    ].join("\n");

    const gitPath = path.join(tempDir, "git");
    const lines = [
      "#!/usr/bin/env sh",
      `echo "$@" >> ${JSON.stringify(logFile)}`,
      'if [ "$1" = "worktree" ]; then',
      `  cat <<'WTEOF'`,
      ...worktreeListOut.split("\n"),
      "WTEOF",
      'elif [ "$1" = "branch" ]; then',
      '  echo "wrong-branch"',
      "fi",
      "exit 0",
    ];
    writeFileSync(gitPath, lines.join("\n"), { mode: 0o755 });

    const result = await runGate(["--expected-branch", "issue-497"], { cwd: worktreeDir, gitDir: tempDir });

    assert.equal(result.exitCode, 1);
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "branch_mismatch");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("gate skips branch check when --expected-branch not provided", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "preflight-no-branch-"));
  try {
    const worktreeDir = path.join(tempDir, "tmp", "worktrees", "issue-497");
    mkdirSync(worktreeDir, { recursive: true });

    const logFile = path.join(tempDir, "git.log");
    const worktreeListOut = [
      `${realpathSync(tempDir)}  535a18a [main]`,
      `${realpathSync(worktreeDir)}  535a18a [issue-497]`,
    ].join("\n");

    writeGitStub(tempDir, { worktreeListOut, logFile });

    const result = await runGate([], { cwd: worktreeDir, gitDir: tempDir });

    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.checks.branch, "skipped");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Subagent availability
// ---------------------------------------------------------------------------

test("gate reports subagent status skipped when --check-subagents not set", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "preflight-subagent-skip-"));
  try {
    const worktreeDir = path.join(tempDir, "tmp", "worktrees", "issue-497");
    mkdirSync(worktreeDir, { recursive: true });

    const logFile = path.join(tempDir, "git.log");
    const worktreeListOut = [
      `${realpathSync(tempDir)}  535a18a [main]`,
      `${realpathSync(worktreeDir)}  535a18a [issue-497]`,
    ].join("\n");

    writeGitStub(tempDir, { worktreeListOut, logFile });

    const result = await runGate([], {
      cwd: worktreeDir,
      gitDir: tempDir,
      env: { DEVLOOPS_SUBAGENT_AVAILABLE: "1" },
    });

    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.checks.subagents, "skipped");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("gate reports subagent available when DEVLOOPS_SUBAGENT_AVAILABLE=1 and --check-subagents", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "preflight-subagent-ok-"));
  try {
    const worktreeDir = path.join(tempDir, "tmp", "worktrees", "issue-497");
    mkdirSync(worktreeDir, { recursive: true });

    const logFile = path.join(tempDir, "git.log");
    const worktreeListOut = [
      `${realpathSync(tempDir)}  535a18a [main]`,
      `${realpathSync(worktreeDir)}  535a18a [issue-497]`,
    ].join("\n");

    writeGitStub(tempDir, { worktreeListOut, logFile });

    const result = await runGate(["--check-subagents"], {
      cwd: worktreeDir,
      gitDir: tempDir,
      env: { DEVLOOPS_SUBAGENT_AVAILABLE: "1" },
    });

    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.checks.subagents, "available");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("gate reports subagent unavailable when --check-subagents and env var not set", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "preflight-subagent-unavail-"));
  try {
    const worktreeDir = path.join(tempDir, "tmp", "worktrees", "issue-497");
    mkdirSync(worktreeDir, { recursive: true });

    const logFile = path.join(tempDir, "git.log");
    const worktreeListOut = [
      `${realpathSync(tempDir)}  535a18a [main]`,
      `${realpathSync(worktreeDir)}  535a18a [issue-497]`,
    ].join("\n");

    writeGitStub(tempDir, { worktreeListOut, logFile });

    const result = await runGate(["--check-subagents"], { cwd: worktreeDir, gitDir: tempDir });

    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.checks.subagents, "unavailable");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

test("success output is valid JSON on stdout", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "preflight-output-ok-"));
  try {
    const worktreeDir = path.join(tempDir, "tmp", "worktrees", "issue-497");
    mkdirSync(worktreeDir, { recursive: true });

    const logFile = path.join(tempDir, "git.log");
    const worktreeListOut = [
      `${realpathSync(tempDir)}  535a18a [main]`,
      `${realpathSync(worktreeDir)}  535a18a [issue-497]`,
    ].join("\n");

    const gitPath = path.join(tempDir, "git");
    const branchAwareLines = [
      "#!/usr/bin/env sh",
      `echo "$@" >> ${JSON.stringify(logFile)}`,
      'if [ "$1" = "worktree" ]; then',
      `  cat <<'WTEOF'`,
      ...worktreeListOut.split("\n"),
      "WTEOF",
      'elif [ "$1" = "branch" ]; then',
      '  echo "issue-497"',
      "fi",
      "exit 0",
    ];
    writeFileSync(gitPath, branchAwareLines.join("\n"), { mode: 0o755 });

    const result = await runGate(["--expected-branch", "issue-497"], {
      cwd: worktreeDir,
      gitDir: tempDir,
      env: { DEVLOOPS_SUBAGENT_AVAILABLE: "1" },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(typeof payload.checks, "object");
    assert.equal(typeof payload.summary, "string");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("failure output is valid JSON on stderr with error + guidance + checks", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "preflight-output-fail-"));
  try {
    const logFile = path.join(tempDir, "git.log");
    const worktreeListOut = `${realpathSync(tempDir)}  535a18a [main]`;

    writeGitStub(tempDir, { worktreeListOut, logFile });

    const result = await runGate([], { cwd: tempDir });

    assert.equal(result.exitCode, 1);
    assert.ok(result.stderr.length > 0, "stderr should have content");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.equal(typeof payload.error, "string");
    assert.equal(typeof payload.guidance, "string");
    assert.equal(typeof payload.checks, "object");
    assert.equal(payload.checks.worktree, false);
    assert.ok(Array.isArray(payload.errors));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// --help
// ---------------------------------------------------------------------------

test("gate prints usage with --help", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "preflight-help-"));
  try {
    const result = await runGate(["--help"], { cwd: tempDir });
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("Usage"), "stdout should contain usage text");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("gate prints usage with -h", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "preflight-h-"));
  try {
    const result = await runGate(["-h"], { cwd: tempDir });
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("Usage"), "stdout should contain usage text");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
