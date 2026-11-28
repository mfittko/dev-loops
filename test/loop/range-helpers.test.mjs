import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setDefaultTimeout, test } from "bun:test";

import { countPrOwnCommits } from "../../scripts/github/upsert-checkpoint-verdict.mjs";
import { gitStaleSurfaceHits } from "../../scripts/loop/_pre-pr-stale-surface.mjs";
import { initGitFixture, runGitFixture } from "../_helpers.mjs";

setDefaultTimeout(30000); // each case seeds a real git repo

// The PR 3087 state. The baseline B1, a fix commit, then a base refresh merged in.
function reviewerOnlyRepo({ conflictOnly = false, nonBaseOnlyMerge = false, evilMerge = false, overlap = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-only-"));
  initGitFixture(dir, { branch: "main", commit: null });
  const git = (...args) => runGitFixture(dir, args);
  git("config", "commit.gpgsign", "false");
  const sharedLines = (top, bottom) => `${top}\n1\n2\n3\n4\n5\n6\n7\n8\n9\n${bottom}\n`;
  fs.writeFileSync(path.join(dir, "gone.mjs"), "export const goneIdentifierName = 1;\n");
  if (overlap) fs.writeFileSync(path.join(dir, "shared.txt"), sharedLines("top", "bottom"));
  git("add", "."); git("commit", "-qm", "base");
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
  git("checkout", "-qb", "pr");
  fs.writeFileSync(path.join(dir, "a.mjs"), "// uses goneIdentifierName\nexport const a = 1;\n");
  git("add", "."); git("commit", "-qm", "feat: a");
  const baseline = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, "a.mjs"), "// uses goneIdentifierName\nexport const a = 2;\n");
  if (overlap) fs.writeFileSync(path.join(dir, "shared.txt"), sharedLines("top", "pr-bottom"));
  git("add", "."); git("commit", "-qm", "fix: a");
  const fix = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  fs.writeFileSync(path.join(dir, "refreshed.txt"), "from the base\n");
  if (overlap) fs.writeFileSync(path.join(dir, "shared.txt"), sharedLines("main-top", "bottom"));
  if (conflictOnly) fs.writeFileSync(path.join(dir, "a.mjs"), "export const a = \"main\";\n");
  git("rm", "-q", "gone.mjs");
  git("add", "."); git("commit", "-qm", "base moves");
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
  git("checkout", "-q", "pr");
  if (conflictOnly) {
    assert.throws(() => git("merge", "-q", "--no-ff", "--no-commit", "main")); // add/add conflict on a.mjs
    fs.writeFileSync(path.join(dir, "a.mjs"), "export const a = 3;\n");
    git("add", ".");
    git("commit", "-qm", "refresh base with a resolution");
  } else git("merge", "-q", "--no-ff", "-m", "refresh base", "main");
  const mergeHead = git("rev-parse", "HEAD");
  if (nonBaseOnlyMerge || evilMerge) {
    // A merge of a branch that holds PR-own work is not a base-only merge.
    git("checkout", "-qb", "side", baseline);
    fs.writeFileSync(path.join(dir, "side.mjs"), "export const side = 1;\n");
    git("add", "."); git("commit", "-qm", "feat: side");
    git("checkout", "-q", "pr");
    if (evilMerge) {
      // A merge that carries content of its own (a conflict resolution): the resolution diff names evil.mjs, which no parent holds.
      git("merge", "-q", "--no-ff", "--no-commit", "side");
      fs.writeFileSync(path.join(dir, "evil.mjs"), "export const evil = 1;\n");
      git("add", "."); git("commit", "-qm", "merge side with a resolution");
    } else git("merge", "-q", "--no-ff", "-m", "merge side", "side");
  }
  return { dir, baseline: conflictOnly ? fix : baseline, fix, mergeHead, head: git("rev-parse", "HEAD") };
}
const cleanup = (repo) => fs.rmSync(repo.dir, { recursive: true, force: true });

test("AC3: the stale-surface diff keeps a removed gitlink line under diff.ignoreSubmodules=all", () => {
  const repo = reviewerOnlyRepo();
  try {
    const git = (...args) => runGitFixture(repo.dir, args);
    git("config", "diff.ignoreSubmodules", "all"); git("config", "diff.submodule", "log");
    git("update-index", "--add", "--cacheinfo", `160000,${"a".repeat(40)},vendor/sub.md`);
    fs.writeFileSync(path.join(repo.dir, "notes.txt"), `Subproject commit ${"a".repeat(40)}\n`);
    git("add", "notes.txt"); git("commit", "-qm", "add a gitlink");
    const added = git("rev-parse", "HEAD");
    git("update-index", "--force-remove", "vendor/sub.md");
    git("commit", "-qm", "drop the gitlink");
    const { hits } = gitStaleSurfaceHits(repo.dir, added, git("rev-parse", "HEAD"), ["vendor/sub.md"]);
    assert.deepEqual(hits.map((h) => h.site), ["notes.txt:1"], "the removed gitlink line reaches the scan");
  } finally { cleanup(repo); }
});

test("identifiers removed by a base-only merge are excluded from the stale-surface scan", () => {
  const repo = reviewerOnlyRepo();
  try {
    assert.ok(gitStaleSurfaceHits(repo.dir, repo.baseline, repo.head).hits.length > 0, "the plain range sees the base removal");
    assert.deepEqual(gitStaleSurfaceHits(repo.dir, repo.baseline, repo.head, ["a.mjs"]).hits, []);
  } finally { cleanup(repo); }
});

test("gitStaleSurfaceHits reports the hit file and line, whatever the operator's git config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-cfg-"));
  try {
    const git = (...args) => runGitFixture(dir, args);
    fs.mkdirSync(path.join(dir, "test"), { recursive: true });
    fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
    git("init", "-q");
    const sentence = "The delta review reads the changed lines only.";
    const spaced = "The spaced path file keeps this sentence pinned.";
    fs.writeFileSync(path.join(dir, "doc.md"), `${sentence}\n`);
    fs.writeFileSync(path.join(dir, "docs", "my guide café.md"), `${spaced}\n`);
    fs.writeFileSync(path.join(dir, "test", "pin.test.mjs"), `const pinned = "${sentence}";\nconst spaced = "${spaced}";\n`);
    git("add", "-A"); git("commit", "-qm", "c1");
    const base = git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(dir, "doc.md"), "Reworded.\n");
    fs.writeFileSync(path.join(dir, "docs", "my guide café.md"), "Reworded too.\n");
    git("commit", "-qam", "c2");
    const head = git("rev-parse", "HEAD");
    const sites = () => gitStaleSurfaceHits(dir, base, head).hits.map((h) => h.site).sort();
    const expected = ["test/pin.test.mjs:1", "test/pin.test.mjs:2"];
    assert.deepEqual(sites(), expected);
    for (const [key, value] of [["diff.noprefix", "true"], ["color.ui", "always"], ["diff.external", "false"], ["diff.algorithm", "histogram"], ["diff.renames", "copies"], ["diff.orderFile", "/dev/null"], ["core.quotePath", "true"]]) git("config", key, value);
    assert.deepEqual(sites(), expected);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("gitStaleSurfaceHits runs from the top level and ignores diff.relative and diff.interHunkContext", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-sub-"));
  try {
    const git = (...args) => runGitFixture(dir, args);
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    fs.mkdirSync(path.join(dir, "test"), { recursive: true });
    git("init", "-q");
    const first = "Alpha rule text describing the gate behavior";
    const third = "and the second clause ends here.";
    fs.writeFileSync(path.join(dir, "a.md"), `${first}\nkept middle line\n${third}\n`);
    fs.writeFileSync(path.join(dir, "test", "pin.test.mjs"), `const a = "${first}";\nconst b = "${third}";\n`);
    fs.writeFileSync(path.join(dir, "sub", "x.txt"), "x\n");
    git("add", "-A"); git("commit", "-qm", "c1");
    const base = git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(dir, "a.md"), "kept middle line\n");
    git("commit", "-qam", "c2");
    const head = git("rev-parse", "HEAD");
    const sites = () => gitStaleSurfaceHits(path.join(dir, "sub"), base, head).hits.map((h) => `${h.file}:${h.line}`).sort();
    const expected = ["test/pin.test.mjs:1", "test/pin.test.mjs:2"];
    assert.deepEqual(sites(), expected);
    git("config", "diff.relative", "true");
    git("config", "diff.interHunkContext", "1");
    assert.deepEqual(sites(), expected);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("AC11: countPrOwnCommits is 0 for a base-only merge range and counts PR-own commits, with baseline and head in that order", async () => {
  const repo = reviewerOnlyRepo();
  const deps = { fetchBase: () => {} };
  try {
    assert.equal(await countPrOwnCommits(repo.dir, repo.fix, repo.head, "main", deps), 0, "fix..head holds only the base-only merge");
    assert.equal(await countPrOwnCommits(repo.dir, repo.baseline, repo.head, "main", deps), 1, "baseline..head holds the fix commit");
    const overlap = reviewerOnlyRepo({ overlap: true });
    try { assert.equal(await countPrOwnCommits(overlap.dir, overlap.fix, overlap.mergeHead, "main", deps), 1, "an overlapping clean merge counts as one PR-own commit"); } finally { cleanup(overlap); }
    await assert.rejects(countPrOwnCommits(repo.dir, repo.head, repo.baseline, "main", deps), /own_commit_in_range: .* does not descend/, "swapped arguments name a non-descendant head");
    await assert.rejects(countPrOwnCommits(repo.dir, repo.baseline, repo.head, "gone", deps), /origin\/gone does not exist/);
  } finally { cleanup(repo); }
  const merged = reviewerOnlyRepo({ nonBaseOnlyMerge: true });
  try {
    assert.equal(await countPrOwnCommits(merged.dir, merged.mergeHead, merged.head, "main", deps), 1, "a clean non-base-only merge resolves nothing, so only its side commit counts");
  } finally { cleanup(merged); }
  const evil = reviewerOnlyRepo({ evilMerge: true });
  try {
    assert.equal(await countPrOwnCommits(evil.dir, evil.mergeHead, evil.head, "main", deps), 2, "the side commit plus the resolved merge");
  } finally { cleanup(evil); }
  const conflict = reviewerOnlyRepo({ conflictOnly: true });
  try {
    assert.equal(await countPrOwnCommits(conflict.dir, conflict.fix, conflict.head, "main", deps), 1, "the conflict resolution is the only change and counts");
  } finally { cleanup(conflict); }
});

test("countPrOwnCommits is 1 for a clean merge whose base commit touches a PR-changed file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clean-merge-"));
  initGitFixture(dir, { branch: "main", commit: null });
  const git = (...args) => runGitFixture(dir, args);
  git("config", "commit.gpgsign", "false");
  const lines = (top, bottom) => `${top}\n1\n2\n3\n4\n5\n6\n7\n8\n9\n${bottom}\n`;
  fs.writeFileSync(path.join(dir, "f.txt"), lines("top", "bottom"));
  git("add", "."); git("commit", "-qm", "base");
  git("checkout", "-qb", "pr");
  fs.writeFileSync(path.join(dir, "f.txt"), lines("top", "pr-bottom"));
  git("add", "."); git("commit", "-qm", "feat: f");
  const before = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  fs.writeFileSync(path.join(dir, "f.txt"), lines("base-top", "bottom"));
  git("add", "."); git("commit", "-qm", "base moves f");
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
  git("checkout", "-q", "pr");
  git("merge", "-q", "--no-ff", "-m", "refresh base", "main");
  try {
    assert.equal(await countPrOwnCommits(dir, before, git("rev-parse", "HEAD"), "main", { fetchBase: () => {} }), 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
