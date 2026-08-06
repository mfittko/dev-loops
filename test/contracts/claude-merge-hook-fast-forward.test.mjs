import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const hookScript = path.join(repoRoot, ".claude", "hooks", "post-tool-use-merge.mjs");

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
}

function revParse(cwd, ref) {
  return execFileSync("git", ["rev-parse", ref], { cwd, encoding: "utf8" }).trim();
}

test("post-tool-use-merge hook fast-forwards the main checkout's local main to origin/main (#1596)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ff-hook-"));
  const bareDir = path.join(tmp, "origin.git");
  const mainDir = path.join(tmp, "main");
  const cloneDir = path.join(tmp, "clone");

  try {
    // Bare origin repo.
    git(tmp, ["init", "--bare", "-q", bareDir]);

    // Main checkout with commit A, pushed to origin.
    git(tmp, ["init", "-q", "-b", "main", mainDir]);
    git(mainDir, ["config", "user.email", "test@example.com"]);
    git(mainDir, ["config", "user.name", "Test"]);
    git(mainDir, ["commit", "--allow-empty", "-q", "-m", "A"]);
    git(mainDir, ["remote", "add", "origin", bareDir]);
    git(mainDir, ["push", "-q", "origin", "main"]);

    // Advance origin/main to commit B via a temp clone.
    git(tmp, ["clone", "-q", bareDir, cloneDir]);
    git(cloneDir, ["config", "user.email", "test@example.com"]);
    git(cloneDir, ["config", "user.name", "Test"]);
    git(cloneDir, ["commit", "--allow-empty", "-q", "-m", "B"]);
    git(cloneDir, ["push", "-q", "origin", "main"]);

    // mainDir local main is still at A; origin/main (bare) is at B.
    const beforeSha = revParse(mainDir, "main");
    const originSha = revParse(cloneDir, "main");
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
