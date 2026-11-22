import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, test } from "bun:test";

import {
  mergeKeepBothSubsections,
  parseResolvePrConflictsCliArgs,
  resolveAdditiveChangelog,
  resolvePrConflicts,
} from "../../scripts/loop/resolve-pr-conflicts.mjs";
import { refreshDepsIfChanged } from "../../scripts/loop/_worktree-deps.mjs";

describe("parseResolvePrConflictsCliArgs", () => {
  test("rejects unknown flags (typos like --no-verfy)", () => {
    assert.throws(() => parseResolvePrConflictsCliArgs(["--no-verfy"]), /Unknown argument: --no-verfy/);
    assert.throws(() => parseResolvePrConflictsCliArgs(["--pus"]), /Unknown argument: --pus/);
  });
  test("rejects positional arguments", () => {
    assert.throws(() => parseResolvePrConflictsCliArgs(["stray"]), /Unknown argument: stray/);
  });
  test("parses known flags", () => {
    const o = parseResolvePrConflictsCliArgs(["--base", "main", "--no-verify", "--push", "--json"]);
    assert.equal(o.base, "main");
    assert.equal(o.verify, false);
    assert.equal(o.push, true);
    assert.equal(o.json, true);
  });
});

describe("resolveAdditiveChangelog", () => {
  test("keeps BOTH additive list entries (empty base, true insertion on both sides)", () => {
    const conflicted = [
      "## Unreleased",
      "",
      "### Added",
      "<<<<<<< HEAD",
      "- Entry from this branch (#100)",
      "||||||| base",
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
    assert.doesNotMatch(result.content, /<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>/);
  });

  test("fails closed when both sides MODIFY the same existing list line (non-empty base)", () => {
    // Adversarial: lexically both sides "look additive" (list items), but the
    // base shows a shared line was edited — keep-both would duplicate it.
    const conflicted = [
      "<<<<<<< HEAD",
      "- Fix the bug properly (#1)",
      "||||||| base",
      "- Fix the bug (#1)",
      "=======",
      "- Fix the bug correctly (#1)",
      ">>>>>>> origin/main",
    ].join("\n");
    const result = resolveAdditiveChangelog(conflicted);
    assert.equal(result.safe, false);
    assert.match(result.reason, /modifies or deletes/);
  });

  test("fails closed when one side DELETES an existing list line (non-empty base)", () => {
    const conflicted = [
      "<<<<<<< HEAD",
      "||||||| base",
      "- Existing entry (#1)",
      "=======",
      "- Existing entry (#1)",
      "- New entry (#2)",
      ">>>>>>> origin/main",
    ].join("\n");
    const result = resolveAdditiveChangelog(conflicted);
    assert.equal(result.safe, false);
    assert.match(result.reason, /modifies or deletes/);
  });

  test("fails closed when a side rewrites a non-list (prose/heading) line", () => {
    const conflicted = [
      "<<<<<<< HEAD",
      "## Unreleased (this branch wording)",
      "||||||| base",
      "## Unreleased",
      "=======",
      "## Unreleased (main wording)",
      ">>>>>>> origin/main",
    ].join("\n");
    const result = resolveAdditiveChangelog(conflicted);
    assert.equal(result.safe, false);
    assert.match(result.reason, /modifies or deletes/);
  });

  test("fails closed on non-diff3 markers (no base section)", () => {
    const conflicted = [
      "<<<<<<< HEAD",
      "- a",
      "=======",
      "- b",
      ">>>>>>> origin/main",
    ].join("\n");
    const result = resolveAdditiveChangelog(conflicted);
    assert.equal(result.safe, false);
    assert.match(result.reason, /diff3 base section/);
  });

  test("fails closed on malformed markers", () => {
    const conflicted = "<<<<<<< HEAD\n- a\n- b\n";
    const result = resolveAdditiveChangelog(conflicted);
    assert.equal(result.safe, false);
  });

  test("merges duplicate '### Fixed' subsections into ONE heading (both sides add a Fixed block)", () => {
    const conflicted = [
      "## Unreleased",
      "",
      "<<<<<<< HEAD",
      "### Fixed",
      "- ours fix (#100)",
      "",
      "||||||| base",
      "=======",
      "### Fixed",
      "- theirs fix (#101)",
      "",
      ">>>>>>> origin/main",
      "## v1.0.1",
    ].join("\n");
    const result = resolveAdditiveChangelog(conflicted);
    assert.equal(result.safe, true);
    // exactly one "### Fixed" heading, not two consecutive ones
    assert.equal((result.content.match(/^### Fixed$/gmu) || []).length, 1);
    // both items retained, ours before theirs
    assert.match(result.content, /- ours fix \(#100\)/);
    assert.match(result.content, /- theirs fix \(#101\)/);
    assert.ok(result.content.indexOf("#100") < result.content.indexOf("#101"));
    // items are contiguous under the single heading (no interleaved heading)
    assert.match(result.content, /### Fixed\n- ours fix \(#100\)\n- theirs fix \(#101\)/);
    assert.doesNotMatch(result.content, /<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>/);
  });

  test("keeps DISTINCT '### <Type>' subsections separate (Fixed vs Added)", () => {
    const conflicted = [
      "## Unreleased",
      "",
      "<<<<<<< HEAD",
      "### Fixed",
      "- ours fix (#100)",
      "",
      "||||||| base",
      "=======",
      "### Added",
      "- theirs feature (#101)",
      "",
      ">>>>>>> origin/main",
    ].join("\n");
    const result = resolveAdditiveChangelog(conflicted);
    assert.equal(result.safe, true);
    assert.equal((result.content.match(/^### Fixed$/gmu) || []).length, 1);
    assert.equal((result.content.match(/^### Added$/gmu) || []).length, 1);
    assert.match(result.content, /- ours fix \(#100\)/);
    assert.match(result.content, /- theirs feature \(#101\)/);
  });
});

describe("mergeKeepBothSubsections", () => {
  test("plain list blocks (no heading) concatenate ours-then-theirs unchanged", () => {
    assert.deepEqual(
      mergeKeepBothSubsections(["- a", "- b"], ["- c"]),
      ["- a", "- b", "- c"],
    );
  });

  test("same heading merges bodies; distinct headings stay separate", () => {
    assert.deepEqual(
      mergeKeepBothSubsections(["### Fixed", "- a"], ["### Fixed", "- b"]),
      ["### Fixed", "- a", "- b"],
    );
    assert.deepEqual(
      mergeKeepBothSubsections(["### Fixed", "- a"], ["### Added", "- b"]),
      ["### Fixed", "- a", "### Added", "- b"],
    );
  });
});

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
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

  test("both sides add a '### Fixed' block: merges into ONE heading (real git, #1958)", async () => {
    // Base has an empty `## Unreleased`; each side inserts its own `### Fixed`
    // block at the same spot → add/add conflict with an empty merge base.
    const base = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "## v1.0.1",
      "- released thing (#1)",
      "",
    ].join("\n");
    const insert = (item) => base.replace("## Unreleased\n\n", `## Unreleased\n\n### Fixed\n- ${item}\n\n`);
    const { tempDir, workDir } = await setupDivergedRepo({
      baseFile: "CHANGELOG.md",
      baseContent: base,
      oursContent: insert("ours fix (#100)"),
      theirsContent: insert("theirs fix (#101)"),
    });
    try {
      const result = await resolvePrConflicts(
        { repoRoot: workDir, base: "main", verify: false, push: false },
        { env: GIT_ENV },
      );
      assert.equal(result.ok, true);
      assert.equal(result.action, "resolved");
      const merged = await readFile(path.join(workDir, "CHANGELOG.md"), "utf8");
      // exactly one "### Fixed" heading, not two consecutive same-named ones
      assert.equal((merged.match(/^### Fixed$/gmu) || []).length, 1);
      assert.match(merged, /- ours fix \(#100\)/);
      assert.match(merged, /- theirs fix \(#101\)/);
      assert.ok(merged.indexOf("#100") < merged.indexOf("#101"));
      assert.doesNotMatch(merged, /<<<<<<<|>>>>>>>/);
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

  test("fails closed when both sides EDIT the same existing CHANGELOG line (real git)", async () => {
    // Both sides look like list items, but it's a modify of a shared line —
    // keep-both would silently duplicate/corrupt the entry. Must fail closed.
    const ours = CHANGELOG_BASE.replace("- shared earlier entry (#1)", "- shared earlier entry properly (#1)");
    const theirs = CHANGELOG_BASE.replace("- shared earlier entry (#1)", "- shared earlier entry correctly (#1)");
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

  test("fails closed when one side DELETES an existing CHANGELOG line (real git)", async () => {
    const ours = CHANGELOG_BASE.replace("- shared earlier entry (#1)\n", "");
    const theirs = CHANGELOG_BASE.replace("- shared earlier entry (#1)", "- shared earlier entry (#1)\n- theirs added (#101)");
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

  describe("post-resolve verification from the base validation.paths (#3490)", () => {
    const CL_OURS = CHANGELOG_BASE.replace("- shared earlier entry (#1)", "- shared earlier entry (#1)\n- ours added (#100)");
    const CL_THEIRS = CHANGELOG_BASE.replace("- shared earlier entry (#1)", "- shared earlier entry (#1)\n- theirs added (#101)");
    const baseWith = (commands) => () => ({ validation: { paths: commands === null ? [] : [{ match: ["CHANGELOG.md"], surface: "changeset", commands }] } });
    const thrower = () => { throw new Error("must not be called"); };
    const setupChangelog = () => setupDivergedRepo({ baseFile: "CHANGELOG.md", baseContent: CHANGELOG_BASE, oursContent: CL_OURS, theirsContent: CL_THEIRS });
    const recorder = (codes = []) => {
      const calls = [];
      const runVerification = async (command, args) => {
        calls.push([command, ...args].join(" "));
        const code = codes.shift() ?? 0;
        return { code, stdout: "", stderr: code ? "Script not found" : "" };
      };
      return { calls, runVerification };
    };
    const opts = (workDir, extra = {}) => ({ repoRoot: workDir, base: "main", verify: true, push: false, ...extra });

    test("a resolved CHANGELOG runs the base command and reports verified; the checkout block has no effect", async () => {
      const { tempDir, workDir } = await setupChangelog();
      try {
        // The checkout maps CHANGELOG.md to a different command; only the injected base block counts.
        await writeFile(path.join(workDir, ".devloops"), "validation:\n  paths:\n    - { match: CHANGELOG.md, surface: x, commands: [\"checkout-cmd\"] }\n", "utf8");
        git(workDir, ["add", ".devloops"]);
        git(workDir, ["commit", "-q", "-m", "checkout config"]);
        const { calls, runVerification } = recorder();
        const result = await resolvePrConflicts(opts(workDir), { env: GIT_ENV, runVerification, readBase: baseWith(["base-cmd"]) });
        assert.equal(result.action, "resolved");
        assert.equal(result.verified, true);
        assert.deepEqual(calls, ["sh -c base-cmd"]);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    test("a resolved file with no mapped command reports verified false and still pushes", async () => {
      const { tempDir, workDir } = await setupChangelog();
      try {
        git(workDir, ["push", "-q", "-u", "origin", "feature"]);
        const { calls, runVerification } = recorder();
        const result = await resolvePrConflicts(opts(workDir, { push: true }), { env: GIT_ENV, runVerification, readBase: baseWith(null) });
        assert.equal(result.verified, false);
        assert.equal(result.pushed, true);
        assert.deepEqual(calls, []);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    test("an empty command list reports verified false and still pushes", async () => {
      const { tempDir, workDir } = await setupChangelog();
      try {
        git(workDir, ["push", "-q", "-u", "origin", "feature"]);
        const { calls, runVerification } = recorder();
        const result = await resolvePrConflicts(opts(workDir, { push: true }), { env: GIT_ENV, runVerification, readBase: baseWith([]) });
        assert.equal(result.verified, false);
        assert.equal(result.pushed, true);
        assert.deepEqual(calls, []);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    test("a run through a symlinked repo root runs the command at the git toplevel", async () => {
      const { tempDir, workDir } = await setupChangelog();
      try {
        const link = path.join(tempDir, "link");
        await symlink(workDir, link);
        const cwds = [];
        const runVerification = async (_command, _args, spawnOptions) => {
          cwds.push(spawnOptions.cwd);
          return { code: 0, stdout: "", stderr: "" };
        };
        await resolvePrConflicts(opts(link), { env: GIT_ENV, runVerification, readBase: baseWith(["x"]) });
        assert.deepEqual(cwds, [realpathSync(workDir)]);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    test("a throwing runner rolls back to the pre-merge head and a re-run repeats the merge", async () => {
      const { tempDir, workDir } = await setupChangelog();
      try {
        const head = git(workDir, ["rev-parse", "HEAD"]).trim();
        const runVerification = async () => { throw new Error("spawn EAGAIN"); };
        await assert.rejects(
          () => resolvePrConflicts(opts(workDir), { env: GIT_ENV, runVerification, readBase: baseWith(["x"]) }),
          (error) => error.verifyFailed === true && /spawn EAGAIN/.test(error.message),
        );
        assert.equal(git(workDir, ["rev-parse", "HEAD"]).trim(), head);
        const result = await resolvePrConflicts(opts(workDir), { env: GIT_ENV, runVerification: recorder().runVerification, readBase: baseWith(["x"]) });
        assert.equal(result.action, "resolved");
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    test("a refused rollback still fails with verifyFailed and names the head left behind", async () => {
      const { tempDir, workDir } = await setupChangelog();
      try {
        const runVerification = async () => {
          await writeFile(path.join(workDir, "CHANGELOG.md"), "edited by the command\n", "utf8");
          return { code: 1, stdout: "", stderr: "boom" };
        };
        await assert.rejects(
          () => resolvePrConflicts(opts(workDir), { env: GIT_ENV, runVerification, readBase: baseWith(["x"]) }),
          (error) => error.verifyFailed === true && /boom/.test(error.message) && /rollback failed; HEAD left at [0-9a-f]{40}/.test(error.message),
        );
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    test("a failing command rolls back to the pre-merge head and a re-run repeats the merge and the command", async () => {
      const { tempDir, workDir } = await setupChangelog();
      try {
        const head = git(workDir, ["rev-parse", "HEAD"]).trim();
        const { calls, runVerification } = recorder([1, 0]);
        await assert.rejects(
          () => resolvePrConflicts(opts(workDir), { env: GIT_ENV, runVerification, readBase: baseWith(["bun run test:docs"]) }),
          (error) => error.verifyFailed === true && /bun run test:docs/.test(error.message) && /Script not found/.test(error.message),
        );
        assert.equal(git(workDir, ["rev-parse", "HEAD"]).trim(), head);
        const result = await resolvePrConflicts(opts(workDir), { env: GIT_ENV, runVerification, readBase: baseWith(["bun run test:docs"]) });
        assert.equal(result.action, "resolved");
        assert.equal(result.verified, true);
        assert.deepEqual(calls, Array(2).fill("sh -c bun run test:docs"));
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    test("a base reader refusal fails closed with the reason and rolls back", async () => {
      const { tempDir, workDir } = await setupChangelog();
      try {
        const head = git(workDir, ["rev-parse", "HEAD"]).trim();
        const { calls, runVerification } = recorder();
        await assert.rejects(
          () => resolvePrConflicts(opts(workDir), { env: GIT_ENV, runVerification, readBase: () => ({ reason: "cannot read the base branch validation config: boom" }) }),
          (error) => error.verifyFailed === true && /cannot read the base branch validation config: boom/.test(error.message),
        );
        assert.equal(git(workDir, ["rev-parse", "HEAD"]).trim(), head);
        assert.deepEqual(calls, []);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    test("--no-verify skips the base read and every command, with no verified field", async () => {
      const { tempDir, workDir } = await setupChangelog();
      try {
        const { calls, runVerification } = recorder();
        const result = await resolvePrConflicts(opts(workDir, { verify: false }), { env: GIT_ENV, runVerification, readBase: thrower });
        assert.equal(result.action, "resolved");
        assert.equal("verified" in result, false);
        assert.deepEqual(calls, []);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    test("a clean merge reads no config, runs no command, reports verified false and pushes", async () => {
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
        git(workDir, ["push", "-q", "-u", "origin", "feature"]);
        git(workDir, ["checkout", "-q", "main"]);
        await writeFile(path.join(workDir, "b.txt"), "b\n", "utf8");
        git(workDir, ["add", "."]);
        git(workDir, ["commit", "-q", "-m", "theirs"]);
        git(workDir, ["push", "-q", "origin", "main"]);
        git(workDir, ["checkout", "-q", "feature"]);
        const { calls, runVerification } = recorder();
        const result = await resolvePrConflicts(opts(workDir, { push: true }), { env: GIT_ENV, runVerification, readBase: thrower });
        assert.equal(result.action, "clean_merge");
        assert.equal(result.verified, false);
        assert.equal(result.pushed, true);
        assert.deepEqual(calls, []);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    test("a resolved CHANGELOG merge whose base also changes bun.lock installs before the base command", async () => {
      const { tempDir, workDir } = await setupChangelog();
      try {
        git(workDir, ["checkout", "-q", "main"]);
        await writeFile(path.join(workDir, "bun.lock"), "v2\n", "utf8");
        await writeFile(path.join(workDir, ".gitignore"), "node_modules/\n", "utf8");
        git(workDir, ["add", "."]);
        git(workDir, ["commit", "-q", "-m", "base moves lockfile"]);
        git(workDir, ["push", "-q", "origin", "main"]);
        git(workDir, ["checkout", "-q", "feature"]);
        const calls = [];
        const installDeps = () => { calls.push("install"); return { ok: true }; };
        const runVerification = async (command, args) => { calls.push([command, ...args].join(" ")); return { code: 0, stdout: "", stderr: "" }; };
        const result = await resolvePrConflicts(opts(workDir), { env: GIT_ENV, runVerification, installDeps, readBase: baseWith(["base-cmd"]) });
        assert.equal(result.action, "resolved");
        assert.deepEqual(calls, ["install", "sh -c base-cmd"]);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  for (const { title, lockChanged } of [
    { title: "a base merge that changes bun.lock installs once in the worktree", lockChanged: true },
    { title: "a base merge that leaves bun.lock unchanged does not install", lockChanged: false },
  ]) {
    test(title, async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-pr-conflicts-deps-"));
      const remoteDir = path.join(tempDir, "remote.git");
      const workDir = path.join(tempDir, "work");
      try {
        git(tempDir, ["init", "-q", "--bare", remoteDir]);
        git(tempDir, ["clone", "-q", remoteDir, workDir]);
        git(workDir, ["config", "commit.gpgsign", "false"]);
        git(workDir, ["checkout", "-q", "-b", "main"]);
        await writeFile(path.join(workDir, "bun.lock"), "v1\n", "utf8");
        await writeFile(path.join(workDir, ".gitignore"), "node_modules/\n", "utf8");
        git(workDir, ["add", "."]);
        git(workDir, ["commit", "-q", "-m", "base"]);
        git(workDir, ["push", "-q", "-u", "origin", "main"]);
        // Seed the install stamp for the base lockfile so only a real lockfile change triggers an install.
        assert.equal(refreshDepsIfChanged(workDir, () => ({ ok: true })).ran, true);
        git(workDir, ["checkout", "-q", "-b", "feature"]);
        git(workDir, ["checkout", "-q", "main"]);
        await writeFile(path.join(workDir, lockChanged ? "bun.lock" : "other.txt"), "v2\n", "utf8");
        git(workDir, ["add", "."]);
        git(workDir, ["commit", "-q", "-m", "base moves"]);
        git(workDir, ["push", "-q", "origin", "main"]);
        git(workDir, ["checkout", "-q", "feature"]);

        const calls = [];
        const installDeps = (cwd) => {
          calls.push(`install @ ${cwd}`);
          return { ok: true };
        };
        const result = await resolvePrConflicts({ repoRoot: workDir, base: "main", verify: true, push: false }, { env: GIT_ENV, installDeps });
        if (lockChanged) {
          assert.equal(calls.length, 1);
          assert.equal(realpathSync(calls[0].slice("install @ ".length)), realpathSync(workDir));
          assert.equal(result.deps.ran, true);
        } else {
          assert.deepEqual(calls, []);
          assert.equal(result.deps, undefined);
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  }
});

describe("merge commit identity (#2832)", () => {
  // No global/system config, no command-line config (GIT_CONFIG_PARAMETERS,
  // GIT_CONFIG_COUNT/KEY_n/VALUE_n), and no GIT_AUTHOR_*/GIT_COMMITTER_*
  // overrides, so only the repo-local config decides the effective identity.
  const isolatedEnv = () => {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    for (const key of [
      "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
      "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
    ]) delete env[key];
    for (const key of Object.keys(env)) if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete env[key];
    return env;
  };
  const setup = () => setupDivergedRepo({
    baseFile: "CHANGELOG.md",
    baseContent: CHANGELOG_BASE,
    oursContent: CHANGELOG_BASE.replace("- shared earlier entry (#1)", "- shared earlier entry (#1)\n- ours added (#100)"),
    theirsContent: CHANGELOG_BASE.replace("- shared earlier entry (#1)", "- shared earlier entry (#1)\n- theirs added (#101)"),
  });

  test("keeps the ambient identity when user.email is configured", async () => {
    const { tempDir, workDir } = await setup();
    try {
      git(workDir, ["config", "user.email", "dev@example.com"]);
      git(workDir, ["config", "user.name", "Dev"]);
      const result = await resolvePrConflicts(
        { repoRoot: workDir, base: "main", verify: false, push: false },
        { env: isolatedEnv() },
      );
      assert.equal(result.action, "resolved");
      assert.equal(
        git(workDir, ["log", "-1", "--format=%an%n%ae%n%cn%n%ce"]).trim(),
        "Dev\ndev@example.com\nDev\ndev@example.com",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("falls back to the bot identity when user.email is empty", async () => {
    const { tempDir, workDir } = await setup();
    try {
      // An ambient user.name without user.email still gets the full bot pair.
      git(workDir, ["config", "user.name", "Dev"]);
      const result = await resolvePrConflicts(
        { repoRoot: workDir, base: "main", verify: false, push: false },
        { env: isolatedEnv() },
      );
      assert.equal(result.action, "resolved");
      assert.equal(
        git(workDir, ["log", "-1", "--format=%an%n%ae%n%cn%n%ce"]).trim(),
        "dev-loops[bot]\ndev-loops[bot]@users.noreply.github.com\ndev-loops[bot]\ndev-loops[bot]@users.noreply.github.com",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("keeps the ambient identity on a clean (non-conflicting) merge", async () => {
    const base = "1\n2\n3\n4\n5\n6\n7\n8\n";
    const { tempDir, workDir } = await setupDivergedRepo({
      baseFile: "a.txt",
      baseContent: base,
      oursContent: base.replace("1\n", "ours\n"),
      theirsContent: base.replace("8\n", "theirs\n"),
    });
    try {
      git(workDir, ["config", "user.email", "dev@example.com"]);
      git(workDir, ["config", "user.name", "Dev"]);
      const result = await resolvePrConflicts(
        { repoRoot: workDir, base: "main", verify: false, push: false },
        { env: isolatedEnv() },
      );
      assert.equal(result.action, "clean_merge");
      assert.equal(
        git(workDir, ["log", "-1", "--format=%an%n%ae%n%cn%n%ce"]).trim(),
        "Dev\ndev@example.com\nDev\ndev@example.com",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
