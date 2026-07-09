import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";

import { parseBranchGuardCliArgs, runCli } from "../../scripts/loop/pre-commit-branch-guard.mjs";

const scriptPath = path.resolve("scripts/loop/pre-commit-branch-guard.mjs");

const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

async function writeGitStub(tempDir, { branch = "copilot/feature-branch", logFile } = {}) {
  const gitPath = path.join(tempDir, "git");
  // Shell stub (cheap spawn) standing in for the real git binary: it still runs
  // as a subprocess resolved via PATH, so the git-command boundary stays under
  // test, but without paying node startup on every git invocation.
  await writeFile(
    gitPath,
    [
      "#!/usr/bin/env sh",
      'joined="$*"',
      'if [ -n "$BRANCH_GUARD_LOG_FILE" ]; then printf \'%s\\n\' "$joined" >> "$BRANCH_GUARD_LOG_FILE"; fi',
      'if [ "$joined" = "branch --show-current" ]; then',
      `  printf '%s\\n' ${JSON.stringify(branch)}`,
      "  exit 0",
      "fi",
      'printf \'unexpected git args: %s\\n\' "$joined" >&2',
      "exit 1",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(gitPath, 0o755);

  return {
    ...process.env,
    BRANCH_GUARD_LOG_FILE: logFile,
    PATH: `${tempDir}${path.delimiter}${process.env.PATH}`,
  };
}

test("parseBranchGuardCliArgs rejects missing --expected-branch", () => {
  assert.throws(() => parseBranchGuardCliArgs([]), /--expected-branch .* is required/i);
});

test("parseBranchGuardCliArgs parses --expected-branch", () => {
  const options = parseBranchGuardCliArgs(["--expected-branch", "copilot/a"]);
  assert.equal(options.expectedBranch, "copilot/a");
  assert.equal(options.help, false);
});

test("branch guard exits 0 when branch matches expected", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "branch-guard-test-"));
  const logFile = path.join(tempDir, "git.log");

  try {
    const env = await writeGitStub(tempDir, { branch: "copilot/expected", logFile });
    const result = await runNode(["--expected-branch", "copilot/expected"], { env });

    assert.equal(result.code, 0, `expected exit 0, got stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.branch, "copilot/expected");
    assert.equal(parsed.matched, true);

    const gitLog = await readFile(logFile, "utf8");
    assert.match(gitLog, /branch --show-current/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("branch guard exits non-zero with structured mismatch error", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "branch-guard-test-"));
  const logFile = path.join(tempDir, "git.log");

  try {
    const env = await writeGitStub(tempDir, { branch: "copilot/actual", logFile });
    const result = await runNode(["--expected-branch", "copilot/expected"], { env });

    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stderr.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, "branch_mismatch");
    assert.equal(parsed.current, "copilot/actual");
    assert.equal(parsed.expected, "copilot/expected");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("branch guard exits non-zero with usage when --expected-branch is missing", async () => {
  const result = await runNode([]);
  assert.equal(result.code, 1);

  const parsed = JSON.parse(result.stderr.trim());
  assert.equal(parsed.ok, false);
  assert.ok(/required/i.test(parsed.error));
  assert.ok(typeof parsed.usage === "string" && parsed.usage.includes("--expected-branch"));
});

test("parseBranchGuardCliArgs --help returns help flag", () => {
  const options = parseBranchGuardCliArgs(["--help"]);
  assert.equal(options.help, true);
});

test("parseBranchGuardCliArgs -h returns help flag", () => {
  const options = parseBranchGuardCliArgs(["-h"]);
  assert.equal(options.help, true);
});

test("parseBranchGuardCliArgs rejects unknown argument", () => {
  assert.throws(() => parseBranchGuardCliArgs(["--unknown-flag"]), /Unknown argument/i);
});

test("parseBranchGuardCliArgs rejects flag-like value for --expected-branch", () => {
  assert.throws(
    () => parseBranchGuardCliArgs(["--expected-branch", "--other-flag"]),
    /Missing value for --expected-branch/i,
  );
});

test("branch guard exits 0 and prints usage with --help", async () => {
  const result = await runNode(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /--expected-branch/);
});

test("branch guard exits 0 and prints usage with -h", async () => {
  const result = await runNode(["-h"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /--expected-branch/);
});

test("branch guard exits non-zero with structured error for unknown argument", async () => {
  const result = await runNode(["--unexpected-arg"]);
  assert.equal(result.code, 1);
  const parsed = JSON.parse(result.stderr.trim());
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /Unknown argument/i);
});

test("branch guard runCli rejects when git command does not exist (ENOENT)", async () => {
  const chunks = [];
  const errChunks = [];
  const out = { write: (c) => chunks.push(c) };
  const err = { write: (c) => errChunks.push(c) };

  await assert.rejects(
    () =>
      runCli(["--expected-branch", "main"], {
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

test("branch guard runCli rejects when git exits non-zero with empty stderr", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "branch-guard-err-"));
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
      () => runCli(["--expected-branch", "main"], { stdout: out, stderr: err, env }),
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

test("parseBranchGuardCliArgs rejects single-dash flag-like value for --expected-branch", () => {
  assert.throws(
    () => parseBranchGuardCliArgs(["--expected-branch", "-x"]),
    /Missing value for --expected-branch/i,
  );
});


// ── Worktree isolation tests ──────────────────────────────────────────────

import {
  isUnderWorktreePath,
  parseMainWorktreePath,
  isMainCheckout,
} from "../../packages/core/src/loop/worktree-guard.mjs";

async function writeWorktreeGitStub(tempDir, {
  branch = "copilot/feature-branch",
  worktreeListOut = "",
  logFile,
} = {}) {
  const gitPath = path.join(tempDir, "git");
  // Shell stub (cheap spawn) standing in for the real git binary — still spawned
  // as a subprocess resolved via PATH, preserving the git-command boundary, but
  // without node startup per git invocation.
  await writeFile(
    gitPath,
    [
      "#!/usr/bin/env sh",
      'joined="$*"',
      'if [ -n "$BRANCH_GUARD_LOG_FILE" ]; then printf \'%s\\n\' "$joined" >> "$BRANCH_GUARD_LOG_FILE"; fi',
      'if [ "$joined" = "branch --show-current" ]; then',
      `  printf '%s\\n' ${JSON.stringify(branch)}`,
      "  exit 0",
      "fi",
      'if [ "$joined" = "worktree list" ]; then',
      "  cat <<'WTEOF'",
      ...worktreeListOut.split("\n"),
      "WTEOF",
      "  exit 0",
      "fi",
      'printf \'unexpected git args: %s\\n\' "$joined" >&2',
      "exit 1",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(gitPath, 0o755);

  return {
    ...process.env,
    BRANCH_GUARD_LOG_FILE: logFile,
    PATH: `${tempDir}${path.delimiter}${process.env.PATH}`,
  };
}

// ── Unit: isUnderWorktreePath ─────────────────────────────────────────────

test("isUnderWorktreePath: true for tmp/worktrees/ subdirectory", () => {
  assert.equal(isUnderWorktreePath("/home/user/repo/tmp/worktrees/issue-444"), true);
});

test("isUnderWorktreePath: true for deeply nested worktree path", () => {
  assert.equal(isUnderWorktreePath("/a/b/tmp/worktrees/queue-444/sub/dir"), true);
});

test("isUnderWorktreePath: false for main checkout", () => {
  assert.equal(isUnderWorktreePath("/home/user/repo"), false);
});

test("isUnderWorktreePath: false for non-worktree tmp dir", () => {
  assert.equal(isUnderWorktreePath("/home/user/repo/tmp/other"), false);
});

test("isUnderWorktreePath: false for path with 'tmp/worktrees' as substring not segment", () => {
  assert.equal(isUnderWorktreePath("/home/user/not_tmp/worktrees_stuff/here"), false);
});

test("isUnderWorktreePath: handles Windows-style paths", () => {
  assert.equal(isUnderWorktreePath("C:\\Users\\repo\\tmp\\worktrees\\issue-444"), true);
});

// ── Unit: parseMainWorktreePath ───────────────────────────────────────────

test("parseMainWorktreePath: extracts first worktree path", () => {
  const out = "/home/user/repo  abc1234 [main]\n/home/user/repo/tmp/worktrees/issue  abc1234 [feat/x]\n";
  assert.equal(parseMainWorktreePath(out), "/home/user/repo");
});

test("parseMainWorktreePath: handles detached HEAD on main", () => {
  const out = "/home/user/repo  abc1234 (detached HEAD)\n";
  assert.equal(parseMainWorktreePath(out), "/home/user/repo");
});

test("parseMainWorktreePath: returns null for empty output", () => {
  assert.equal(parseMainWorktreePath(""), null);
});

test("parseMainWorktreePath: returns null for whitespace-only", () => {
  assert.equal(parseMainWorktreePath("   \n  "), null);
});

// ── Unit: isMainCheckout ──────────────────────────────────────────────────

test("isMainCheckout: true when cwd matches main worktree exactly", () => {
  assert.equal(isMainCheckout("/home/user/repo", "/home/user/repo"), true);
});

test("isMainCheckout: true when cwd is subdirectory of main worktree", () => {
  assert.equal(isMainCheckout("/home/user/repo/src", "/home/user/repo"), true);
});

test("isMainCheckout: true when cwd is subdirectory of main (even under worktree)", () => {
  // Pure path check: /home/user/repo/tmp/worktrees/x IS a subdirectory of /home/user/repo
  // Worktree exclusion is handled in the CLI orchestration, not here.
  assert.equal(isMainCheckout("/home/user/repo/tmp/worktrees/x", "/home/user/repo"), true);
});

test("isMainCheckout: false when mainWorktreePath is null", () => {
  assert.equal(isMainCheckout("/some/path", null), false);
});

test("isMainCheckout: handles trailing slashes consistently", () => {
  assert.equal(isMainCheckout("/home/user/repo/", "/home/user/repo"), true);
  assert.equal(isMainCheckout("/home/user/repo/tmp/worktrees/x", "/home/user/repo/"), true);
});

// ── CLI: parseBranchGuardCliArgs with worktree flags ──────────────────────

test("parseBranchGuardCliArgs parses --require-worktree", () => {
  const opts = parseBranchGuardCliArgs(["--expected-branch", "feat/x", "--require-worktree"]);
  assert.equal(opts.requireWorktree, true);
  assert.equal(opts.blockMainCheckout, false);
});

test("parseBranchGuardCliArgs parses --block-main-checkout", () => {
  const opts = parseBranchGuardCliArgs(["--expected-branch", "feat/x", "--block-main-checkout"]);
  assert.equal(opts.blockMainCheckout, true);
  assert.equal(opts.requireWorktree, false);
});

test("parseBranchGuardCliArgs parses both worktree flags", () => {
  const opts = parseBranchGuardCliArgs([
    "--expected-branch", "feat/x",
    "--require-worktree",
    "--block-main-checkout",
  ]);
  assert.equal(opts.requireWorktree, true);
  assert.equal(opts.blockMainCheckout, true);
});

// ── CLI: guard passes when under worktree path ────────────────────────────

test("guard passes with --require-worktree when cwd is under tmp/worktrees/", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "branch-guard-wt-"));
  const logFile = path.join(tempDir, "git.log");
  // Create real worktree path under tempDir so spawn cwd works
  const cwd = path.join(tempDir, "tmp", "worktrees", "issue-444");
  await mkdir(cwd, { recursive: true });

  try {
    const env = await writeWorktreeGitStub(tempDir, {
      branch: "copilot/feat",
      worktreeListOut: `${cwd}  abc1234 [copilot/feat]\n`,
      logFile,
    });
    const result = await runNode(
      ["--expected-branch", "copilot/feat", "--require-worktree"],
      { env, cwd },
    );

    assert.equal(result.code, 0, `expected exit 0, got stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.worktreeOk, true);
    assert.equal(parsed.mainCheckoutBlocked, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ── CLI: guard rejects when NOT under worktree path ───────────────────────

test("guard rejects with --require-worktree when cwd is NOT under tmp/worktrees/", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "branch-guard-wt-"));
  const logFile = path.join(tempDir, "git.log");
  const cwd = await realpath(tempDir); // not under tmp/worktrees/

  try {
    const env = await writeWorktreeGitStub(tempDir, {
      branch: "main",
      worktreeListOut: "",
      logFile,
    });
    const result = await runNode(
      ["--expected-branch", "main", "--require-worktree"],
      { env, cwd },
    );

    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stderr.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, "not_in_worktree");
    assert.ok(parsed.cwd.includes("branch-guard-wt"), `cwd ${parsed.cwd} should contain branch-guard-wt`);
    assert.equal(parsed.requiredPrefix, "tmp/worktrees/");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ── CLI: guard blocks main checkout ───────────────────────────────────────

test("guard rejects with --block-main-checkout when cwd is main worktree", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "branch-guard-wt-"));
  const logFile = path.join(tempDir, "git.log");
  const cwd = await realpath(tempDir); // treat as "main" path

  try {
    const env = await writeWorktreeGitStub(tempDir, {
      branch: "main",
      worktreeListOut: `${cwd}  abc1234 [main]\n/tmp/wt  def5678 [feat/x]\n`,
      logFile,
    });
    const result = await runNode(
      ["--expected-branch", "main", "--block-main-checkout"],
      { env, cwd },
    );

    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stderr.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, "main_checkout_blocked");
    assert.ok(parsed.cwd.includes("branch-guard-wt"), `cwd ${parsed.cwd} should contain branch-guard-wt`);
    assert.ok(parsed.mainWorktree.includes("branch-guard-wt"), `mainWorktree ${parsed.mainWorktree} should contain branch-guard-wt`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("guard rejects with --block-main-checkout when cwd is subdirectory of main", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "branch-guard-wt-"));
  const logFile = path.join(tempDir, "git.log");
  const srcDir = path.join(tempDir, "src");
  await mkdir(srcDir, { recursive: true });
  const cwd = await realpath(srcDir);
  const mainPath = await realpath(tempDir);

  try {
    const env = await writeWorktreeGitStub(tempDir, {
      branch: "main",
      worktreeListOut: `${mainPath}  abc1234 [main]\n`,
      logFile,
    });
    const result = await runNode(
      ["--expected-branch", "main", "--block-main-checkout"],
      { env, cwd },
    );

    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stderr.trim());
    assert.equal(parsed.error, "main_checkout_blocked");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ── CLI: block-main-checkout passes when under worktree ───────────────────

test("guard passes with --block-main-checkout when cwd is under tmp/worktrees/", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "branch-guard-wt-"));
  const logFile = path.join(tempDir, "git.log");
  const cwd = path.join(tempDir, "tmp", "worktrees", "issue-444");
  await mkdir(cwd, { recursive: true });

  try {
    const env = await writeWorktreeGitStub(tempDir, {
      branch: "copilot/feat",
      worktreeListOut: `${tempDir}  abc1234 [main]\n${cwd}  abc1234 [copilot/feat]\n`,
      logFile,
    });
    const result = await runNode(
      ["--expected-branch", "copilot/feat", "--block-main-checkout"],
      { env, cwd },
    );

    assert.equal(result.code, 0, `expected exit 0, got stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.mainCheckoutBlocked, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ── CLI: both flags together ──────────────────────────────────────────────

test("guard passes with both --require-worktree and --block-main-checkout from worktree", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "branch-guard-wt-"));
  const logFile = path.join(tempDir, "git.log");
  const cwd = path.join(tempDir, "tmp", "worktrees", "issue-444");
  await mkdir(cwd, { recursive: true });

  try {
    const env = await writeWorktreeGitStub(tempDir, {
      branch: "copilot/feat",
      worktreeListOut: `${tempDir}  abc1234 [main]\n${cwd}  abc1234 [copilot/feat]\n`,
      logFile,
    });
    const result = await runNode(
      ["--expected-branch", "copilot/feat", "--require-worktree", "--block-main-checkout"],
      { env, cwd },
    );

    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.worktreeOk, true);
    assert.equal(parsed.mainCheckoutBlocked, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ── CLI: worktree check default-passes when git worktree list fails ───────

test("guard passes with --block-main-checkout when git worktree list fails", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "branch-guard-wt-"));
  // Use basic git stub that only handles branch --show-current
  const env = await writeGitStub(tempDir, { branch: "main" });

  try {
    const result = await runNode(
      ["--expected-branch", "main", "--block-main-checkout"],
      { env, cwd: tempDir },
    );

    // Should pass because git worktree list fails → can't determine main checkout
    assert.equal(result.code, 0, `expected exit 0, got stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.mainCheckoutBlocked, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ── CLI: branch mismatch still reported before worktree checks ────────────

test("guard reports branch mismatch before worktree checks", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "branch-guard-wt-"));
  const cwd = path.join(tempDir, "tmp", "worktrees", "issue-444");
  await mkdir(cwd, { recursive: true });

  try {
    const env = await writeWorktreeGitStub(tempDir, {
      branch: "wrong-branch",
      worktreeListOut: "",
    });
    const result = await runNode(
      ["--expected-branch", "expected-branch", "--require-worktree"],
      { env, cwd },
    );

    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stderr.trim());
    assert.equal(parsed.error, "branch_mismatch");
    assert.equal(parsed.current, "wrong-branch");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ── CLI: --require-worktree fails when not under worktree, even if branch matches ──

test("guard rejects --require-worktree even when branch matches", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "branch-guard-wt-"));
  const logFile = path.join(tempDir, "git.log");

  try {
    const env = await writeWorktreeGitStub(tempDir, {
      branch: "main",
      worktreeListOut: "",
      logFile,
    });
    const result = await runNode(
      ["--expected-branch", "main", "--require-worktree"],
      { env, cwd: tempDir },
    );

    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stderr.trim());
    assert.equal(parsed.error, "not_in_worktree");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ── Unit: parseMainWorktreePath edge cases ────────────────────────────────

test("parseMainWorktreePath: handles multiple spaces between path and sha", () => {
  const out = "/home/repo    abc1234 [main]\n";
  assert.equal(parseMainWorktreePath(out), "/home/repo");
});

test("parseMainWorktreePath: handles only one worktree listed", () => {
  const out = "/only/path  abc1234 [main]\n";
  assert.equal(parseMainWorktreePath(out), "/only/path");
});
