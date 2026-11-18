import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeGitStub } from "./outer-loop-test-helpers.mjs";

test("writeGitStub forwards only the four trust-read shapes and exits 97 for every other git call", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "git-stub-"));
  try {
    const env = await writeGitStub(dir);
    const run = (args) => spawnSync("git", args, { cwd: dir, env, encoding: "utf8" }).status;
    for (const args of [
      ["fetch", "origin"],
      ["fetch", "origin", "main"],
      ["rev-parse", "origin/main"],
      ["show", "HEAD:.devloops"],
      ["ls-tree", "HEAD"],
    ]) assert.equal(run(args), 97, args.join(" "));
    // Accepted forms reach real git (not exit 97); in a non-repo cwd real git fails with another status.
    for (const args of [
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      ["rev-parse", "--verify", "--quiet", "origin/main^{commit}"],
      ["ls-tree", "--name-only", "origin/main", "--", ".devloops"],
      ["show", "origin/main:.devloops"],
    ]) assert.notEqual(run(args), 97, args.join(" "));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
