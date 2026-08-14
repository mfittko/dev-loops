import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const hookScript = path.join(repoRoot, ".claude", "hooks", "post-tool-use-merge.mjs");

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function revParse(cwd, ref) {
  return execFileSync("git", ["rev-parse", ref], { cwd, encoding: "utf8" }).trim();
}

test("post-tool-use-merge hook fast-forwards the main checkout's local main to origin/main (#1596)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ff-hook-"));
  const originDir = path.join(tmp, "origin");
  const mainDir = path.join(tmp, "main");

  try {
    // Normal origin repo with commit A, then commit B (B at HEAD).
    git(tmp, ["init", "-q", originDir]);
    git(originDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(originDir, ["config", "user.email", "test@example.com"]);
    git(originDir, ["config", "user.name", "Test"]);
    git(originDir, ["config", "commit.gpgsign", "false"]);
    git(originDir, ["commit", "--allow-empty", "-q", "-m", "A"]);
    const commitASha = revParse(originDir, "HEAD");
    git(originDir, ["commit", "--allow-empty", "-q", "-m", "B"]);
    const originSha = revParse(originDir, "HEAD");
    assert.notEqual(commitASha, originSha, "origin must have two distinct commits");

    // Clone origin so mainDir local main = B and refs/remotes/origin/main = B.
    git(tmp, ["clone", "-q", originDir, mainDir]);

    // Put local main behind origin/main: reset to A (remote-tracking stays at B).
    git(mainDir, ["reset", "--hard", commitASha]);
    const beforeSha = revParse(mainDir, "main");
    assert.notEqual(beforeSha, originSha, "local main must start behind origin/main");

    // Run the hook as a PostToolUse Bash event for a merge-capable command.
    const res = spawnSync("node", [hookScript], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "gh pr merge 42 --squash --delete-branch" },
        cwd: mainDir,
      }),
      encoding: "utf8",
      env: { ...process.env },
      cwd: mainDir,
    });

    assert.equal(res.status, 0, `hook must exit 0 (got ${res.status}, stderr: ${res.stderr})`);

    const afterSha = revParse(mainDir, "main");
    assert.equal(afterSha, originSha, "local main advanced to origin/main");
    assert.notEqual(afterSha, beforeSha, "local main actually moved");

    assert.match(res.stderr, /fast-forwarded/, "hook must emit a fast-forwarded stderr note");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("post-tool-use-merge hook skips with a note when the main checkout cannot be resolved (#1596)", async () => {
  // A NON-git temp directory: `git worktree list` fails → mainCheckout stays null.
  const nonGit = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ff-hook-nogit-"));

  try {
    const res = spawnSync("node", [hookScript], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "gh pr merge 42 --squash --delete-branch" },
        cwd: nonGit,
      }),
      encoding: "utf8",
      env: { ...process.env },
      cwd: nonGit,
    });

    assert.equal(res.status, 0, `hook must exit 0 (got ${res.status}, stderr: ${res.stderr})`);
    assert.match(res.stderr, /could not resolve main checkout/, "hook must note it could not resolve the main checkout");
  } finally {
    await rm(nonGit, { recursive: true, force: true });
  }
});

test("post-tool-use-merge hook warns and exits 0 when fast-forward is non-fast-forwardable (diverged main) (#1596)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ff-hook-diverged-"));
  const originDir = path.join(tmp, "origin");
  const mainDir = path.join(tmp, "main");

  try {
    // Origin: A then B (B at HEAD).
    git(tmp, ["init", "-q", originDir]);
    git(originDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(originDir, ["config", "user.email", "test@example.com"]);
    git(originDir, ["config", "user.name", "Test"]);
    git(originDir, ["config", "commit.gpgsign", "false"]);
    git(originDir, ["commit", "--allow-empty", "-q", "-m", "A"]);
    const commitASha = revParse(originDir, "HEAD");
    git(originDir, ["commit", "--allow-empty", "-q", "-m", "B"]);

    // Clone so mainDir local main = B and refs/remotes/origin/main = B.
    git(tmp, ["clone", "-q", originDir, mainDir]);
    // Local main = A (behind), then add commit C so local main = A+C (diverged from origin B).
    git(mainDir, ["reset", "--hard", commitASha]);
    git(mainDir, ["config", "user.email", "test@example.com"]);
    git(mainDir, ["config", "user.name", "Test"]);
    git(mainDir, ["config", "commit.gpgsign", "false"]);
    git(mainDir, ["commit", "--allow-empty", "-q", "-m", "C"]);

    const res = spawnSync("node", [hookScript], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "gh pr merge 42 --squash --delete-branch" },
        cwd: mainDir,
      }),
      encoding: "utf8",
      env: { ...process.env },
      cwd: mainDir,
    });

    assert.equal(res.status, 0, `hook must exit 0 (got ${res.status}, stderr: ${res.stderr})`);
    assert.match(res.stderr, /skipped \(best-effort\)/, "hook must warn and skip on a diverged main");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("post-tool-use-merge hook runs post-merge worktree cleanup for the merged PR (#1627)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dev-loops-cleanup-hook-"));
  const originDir = path.join(tmp, "origin");
  const mainDir = path.join(tmp, "main");

  try {
    git(tmp, ["init", "-q", originDir]);
    git(originDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(originDir, ["config", "user.email", "test@example.com"]);
    git(originDir, ["config", "user.name", "Test"]);
    git(originDir, ["config", "commit.gpgsign", "false"]);
    git(originDir, ["commit", "--allow-empty", "-q", "-m", "A"]);
    git(originDir, ["commit", "--allow-empty", "-q", "-m", "B"]);
    git(tmp, ["clone", "-q", originDir, mainDir]);

    // The dev-loops cleanup script exists in this main checkout; the hook must invoke
    // it for the merged PR, running from the main checkout.
    const scriptPath = path.join(mainDir, "scripts", "loop", "cleanup-worktree.mjs");
    await mkdir(path.dirname(scriptPath), { recursive: true });
    const runLog = path.join(tmp, "cleanup.log");
    await writeFile(
      scriptPath,
      `import fs from "node:fs";const a=process.argv.slice(2);` +
        `const i=a.indexOf("--pr");fs.writeFileSync(${JSON.stringify(runLog)}, "ran "+a[i+1]);\n`,
      { mode: 0o755 },
    );

    const res = spawnSync("node", [hookScript], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "gh pr merge 42 --squash --delete-branch" },
        cwd: mainDir,
      }),
      encoding: "utf8",
      env: { ...process.env },
      cwd: mainDir,
    });

    assert.equal(res.status, 0, `hook must exit 0 (got ${res.status}, stderr: ${res.stderr})`);
    // Mutation anchor: if the cleanup block in post-tool-use-merge.mjs is reverted, the
    // cleanup script is never run and this assertion fails.
    const log = execFileSync("cat", [runLog], { encoding: "utf8" }).trim();
    assert.equal(log, "ran 42", `expected cleanup to run for PR 42, got: ${log}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
