import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "bun:test";
import { initGitFixture, runGitFixture } from "../_helpers.mjs";
import { checkBaseFreshness } from "../../scripts/loop/pre-write-remote-freshness-guard.mjs";
import { defaultIsAncestor } from "../../scripts/github/merge-pr.mjs";

// GATE-EXEC-BASE-REFRESH: the coordination check and the merge-time check must agree on "head contains origin/<base>".
describe("base freshness predicate agreement", () => {
  let root;
  let clone;
  const commit = async (cwd, file, msg) => {
    await writeFile(path.join(cwd, file), msg);
    runGitFixture(cwd, ["add", file]);
    runGitFixture(cwd, ["commit", "-q", "-m", msg]);
    return runGitFixture(cwd, ["rev-parse", "HEAD"]);
  };
  const heads = {};

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "dev-loops-base-fresh-agree-"));
    const origin = path.join(root, "origin.git");
    runGitFixture(root, ["init", "-q", "--bare", "-b", "main", origin]);
    clone = path.join(root, "clone");
    runGitFixture(root, ["clone", "-q", origin, clone]);
    initGitFixture(clone, { branch: "main", commit: null });
    heads.base = await commit(clone, "a.txt", "base");
    runGitFixture(clone, ["push", "-q", "origin", "main"]);
    runGitFixture(clone, ["checkout", "-q", "-b", "feature"]);
    heads.diverged = await commit(clone, "f.txt", "feature work");
    runGitFixture(clone, ["checkout", "-q", "main"]);
    heads.newBase = await commit(clone, "b.txt", "newer base");
    runGitFixture(clone, ["push", "-q", "origin", "main"]);
    runGitFixture(clone, ["checkout", "-q", "feature"]);
    runGitFixture(clone, ["merge", "-q", "--no-edit", heads.newBase]);
    heads.merged = runGitFixture(clone, ["rev-parse", "HEAD"]);
    heads.mergedAhead = await commit(clone, "g.txt", "more feature work");
    runGitFixture(clone, ["checkout", "-q", "main"]);
    runGitFixture(clone, ["reset", "-q", "--hard", heads.base]);
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  for (const [name, key, expected] of [["current", "newBase", true], ["stale", "base", false], ["diverged", "diverged", false], ["merged origin/main", "merged", true], ["ahead of merged base", "mergedAhead", true]]) {
    it(`${name} head: both predicates agree`, async () => {
      const head = heads[key];
      const fresh = await checkBaseFreshness({ base: "main", head, cwd: clone, trusted: true });
      assert.equal(fresh.ok, expected);
      if (!expected) assert.equal(fresh.error, "base_stale_integrate_first");
      assert.equal(defaultIsAncestor({ base: "origin/main", head, repoRoot: clone }), fresh.ok);
    });
  }
});
