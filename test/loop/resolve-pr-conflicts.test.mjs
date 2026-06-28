import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";

import { resolveAdditiveChangelog, resolvePrConflicts } from "../../scripts/loop/resolve-pr-conflicts.mjs";

// ── pure unit: resolveAdditiveChangelog ──────────────────────────────

describe("resolveAdditiveChangelog", () => {
  test("keeps BOTH additive list entries, in order (ours then theirs)", () => {
    const conflicted = [
      "## Unreleased",
      "",
      "### Added",
      "<<<<<<< HEAD",
      "- Entry from this branch (#100)",
      "=======",
      "- Entry from main (#101)",
      ">>>>>>> origin/main",
      "",
    ].join("\n");
    const result = resolveAdditiveChangelog(conflicted);
    assert.equal(result.safe, true);
    assert.match(result.content, /- Entry from this branch \(#100\)/);
    assert.match(result.content, /- Entry from main \(#101\)/);
    // ours precedes theirs
    assert.ok(result.content.indexOf("#100") < result.content.indexOf("#101"));
    // no conflict markers remain
    assert.doesNotMatch(result.content, /<<<<<<<|=======|>>>>>>>/);
  });

  test("fails closed when a side rewrites a non-list (prose/heading) line", () => {
    const conflicted = [
      "<<<<<<< HEAD",
      "## Unreleased (this branch wording)",
      "=======",
      "## Unreleased (main wording)",
      ">>>>>>> origin/main",
    ].join("\n");
    const result = resolveAdditiveChangelog(conflicted);
    assert.equal(result.safe, false);
    assert.match(result.reason, /not purely additive/);
  });

  test("fails closed on malformed markers", () => {
    const conflicted = "<<<<<<< HEAD\n- a\n- b\n";
    const result = resolveAdditiveChangelog(conflicted);
    assert.equal(result.safe, false);
  });
});

// ── real-git fixtures ────────────────────────────────────────────────

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

// Build a bare remote with `main`, then a feature branch forked from an older
// main, then advance main — so the feature branch is BEHIND and conflicts on the
// chosen file. Returns the feature-branch working tree dir.
async function setupDivergedRepo({ baseFile, baseContent, oursContent, theirsContent }) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-pr-conflicts-"));
  const remoteDir = path.join(tempDir, "remote.git");
  const workDir = path.join(tempDir, "work");

  git(tempDir, ["init", "-q", "--bare", remoteDir]);
  git(tempDir, ["clone", "-q", remoteDir, workDir]);
  git(workDir, ["config", "commit.gpgsign", "false"]);
  git(workDir, ["checkout", "-q", "-b", "main"]);

  await mkdir(path.dirname(path.join(workDir, baseFile)), { recursive: true });
  await writeFile(path.join(workDir, baseFile), baseContent, "utf8");
  git(workDir, ["add", "."]);
  git(workDir, ["commit", "-q", "-m", "base"]);
  git(workDir, ["push", "-q", "-u", "origin", "main"]);

  // feature branch from base
  git(workDir, ["checkout", "-q", "-b", "feature"]);
  await writeFile(path.join(workDir, baseFile), oursContent, "utf8");
  git(workDir, ["commit", "-q", "-am", "ours"]);

  // advance main with a conflicting change, push it
  git(workDir, ["checkout", "-q", "main"]);
  await writeFile(path.join(workDir, baseFile), theirsContent, "utf8");
  git(workDir, ["commit", "-q", "-am", "theirs"]);
  git(workDir, ["push", "-q", "origin", "main"]);

  // back on feature for the resolve run
  git(workDir, ["checkout", "-q", "feature"]);
  return { tempDir, workDir };
}

const CHANGELOG_BASE = [
  "# Changelog",
  "",
  "## Unreleased",
  "",
  "### Added",
  "- shared earlier entry (#1)",
  "",
].join("\n");

describe("resolvePrConflicts (real git)", () => {
  test("auto-resolves an additive CHANGELOG conflict: keeps both, commits, branch becomes mergeable", async () => {
    const ours = CHANGELOG_BASE.replace("- shared earlier entry (#1)", "- shared earlier entry (#1)\n- ours added (#100)");
    const theirs = CHANGELOG_BASE.replace("- shared earlier entry (#1)", "- shared earlier entry (#1)\n- theirs added (#101)");
    const { tempDir, workDir } = await setupDivergedRepo({
      baseFile: "CHANGELOG.md",
      baseContent: CHANGELOG_BASE,
      oursContent: ours,
      theirsContent: theirs,
    });
    try {
      const result = await resolvePrConflicts(
        { repoRoot: workDir, base: "main", verify: false, push: false },
        { env: GIT_ENV },
      );
      assert.equal(result.ok, true);
      assert.equal(result.action, "resolved");
      assert.deepEqual(result.resolvedFiles, ["CHANGELOG.md"]);
      const merged = await readFile(path.join(workDir, "CHANGELOG.md"), "utf8");
      assert.match(merged, /- ours added \(#100\)/);
      assert.match(merged, /- theirs added \(#101\)/);
      assert.doesNotMatch(merged, /<<<<<<<|>>>>>>>/);
      // no unmerged paths remain
      const status = git(workDir, ["diff", "--name-only", "--diff-filter=U"]);
      assert.equal(status.trim(), "");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("fails closed naming the conflicted path when a NON-CHANGELOG file conflicts", async () => {
    const { tempDir, workDir } = await setupDivergedRepo({
      baseFile: "src/app.js",
      baseContent: "const x = 1;\n",
      oursContent: "const x = 2;\n",
      theirsContent: "const x = 3;\n",
    });
    try {
      await assert.rejects(
        () => resolvePrConflicts({ repoRoot: workDir, base: "main", verify: false, push: false }, { env: GIT_ENV }),
        (err) => {
          assert.match(err.message, /Unresolvable merge conflict/);
          assert.match(err.message, /src\/app\.js/);
          assert.deepEqual(err.conflictFiles, ["src/app.js"]);
          return true;
        },
      );
      // merge was aborted — tree is clean, no unmerged paths
      const status = git(workDir, ["diff", "--name-only", "--diff-filter=U"]);
      assert.equal(status.trim(), "");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("fails closed when the CHANGELOG conflict is NON-additive (prose rewrite)", async () => {
    const ours = CHANGELOG_BASE.replace("## Unreleased", "## Unreleased — ours");
    const theirs = CHANGELOG_BASE.replace("## Unreleased", "## Unreleased — theirs");
    const { tempDir, workDir } = await setupDivergedRepo({
      baseFile: "CHANGELOG.md",
      baseContent: CHANGELOG_BASE,
      oursContent: ours,
      theirsContent: theirs,
    });
    try {
      await assert.rejects(
        () => resolvePrConflicts({ repoRoot: workDir, base: "main", verify: false, push: false }, { env: GIT_ENV }),
        (err) => {
          assert.match(err.message, /Unresolvable CHANGELOG\.md conflict/);
          assert.deepEqual(err.conflictFiles, ["CHANGELOG.md"]);
          return true;
        },
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("clean merge (no conflict) reports clean_merge", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-pr-conflicts-clean-"));
    const remoteDir = path.join(tempDir, "remote.git");
    const workDir = path.join(tempDir, "work");
    try {
      git(tempDir, ["init", "-q", "--bare", remoteDir]);
      git(tempDir, ["clone", "-q", remoteDir, workDir]);
      git(workDir, ["config", "commit.gpgsign", "false"]);
      git(workDir, ["checkout", "-q", "-b", "main"]);
      await writeFile(path.join(workDir, "a.txt"), "a\n", "utf8");
      git(workDir, ["add", "."]);
      git(workDir, ["commit", "-q", "-m", "base"]);
      git(workDir, ["push", "-q", "-u", "origin", "main"]);
      git(workDir, ["checkout", "-q", "-b", "feature"]);
      // advance main on a disjoint file
      git(workDir, ["checkout", "-q", "main"]);
      await writeFile(path.join(workDir, "b.txt"), "b\n", "utf8");
      git(workDir, ["add", "."]);
      git(workDir, ["commit", "-q", "-m", "theirs"]);
      git(workDir, ["push", "-q", "origin", "main"]);
      git(workDir, ["checkout", "-q", "feature"]);

      const result = await resolvePrConflicts({ repoRoot: workDir, base: "main", verify: false, push: false }, { env: GIT_ENV });
      assert.equal(result.action, "clean_merge");
      assert.deepEqual(result.resolvedFiles, []);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
