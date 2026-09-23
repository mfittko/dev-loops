import assert from "node:assert/strict";
import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assembleFragments,
  fragmentBodyClosesSection,
  fragmentFormatErrors,
  isChangelogFragmentPath,
  readFragments,
  unreleasedFormatErrors,
} from "../../scripts/release/assemble-changelog-fragments.mjs";

const CHANGELOG = `# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- Existing pending entry.

## 1.0.3

- Old release entry.
`;

test("isChangelogFragmentPath matches changes/<slug>.md and excludes README", () => {
  assert.equal(isChangelogFragmentPath("changes/2293-foo.md"), true);
  assert.equal(isChangelogFragmentPath("changes/anything.md"), true);
  assert.equal(isChangelogFragmentPath("changes\\win-slash.md"), false, "git paths use /, not \\; a literal backslash name is not a fragment");
  assert.equal(isChangelogFragmentPath("changes/README.md"), false);
  assert.equal(isChangelogFragmentPath("changes/readme.md"), false);
  assert.equal(isChangelogFragmentPath("changes/nested/x.md"), false);
  assert.equal(isChangelogFragmentPath("CHANGELOG.md"), false);
  assert.equal(isChangelogFragmentPath("changes/notes.txt"), false);
  assert.equal(isChangelogFragmentPath(""), false);
});

test("assembleFragments appends fragment bodies to the Unreleased section, preserving existing entries", () => {
  const { changelog, consumed } = assembleFragments({
    changelog: CHANGELOG,
    fragments: [
      { name: "b-second", content: "- Second change.\n" },
      { name: "a-first", content: "- First change.\n" },
    ],
  });
  assert.deepEqual(consumed, ["b-second", "a-first"]);
  // Existing entry survives; both fragments land under Unreleased, before 1.0.3.
  const unreleased = changelog.slice(
    changelog.indexOf("## Unreleased"),
    changelog.indexOf("## 1.0.3"),
  );
  assert.match(unreleased, /Existing pending entry/);
  assert.match(unreleased, /First change/);
  assert.match(unreleased, /Second change/);
  assert.ok(!changelog.slice(changelog.indexOf("## 1.0.3")).includes("First change"));
});

test("assembleFragments is a no-op when there are no (non-empty) fragments", () => {
  assert.deepEqual(assembleFragments({ changelog: CHANGELOG, fragments: [] }), {
    changelog: CHANGELOG,
    consumed: [],
  });
  // Empty-content fragments document nothing and are ignored.
  assert.deepEqual(
    assembleFragments({ changelog: CHANGELOG, fragments: [{ name: "x", content: "   \n" }] }),
    { changelog: CHANGELOG, consumed: [] },
  );
});

test("assembleFragments creates an Unreleased section when none exists", () => {
  const noUnreleased = "# Changelog\n\n## 1.0.3\n\n- Old.\n";
  const { changelog } = assembleFragments({
    changelog: noUnreleased,
    fragments: [{ name: "x", content: "- New change.\n" }],
  });
  assert.match(changelog, /## Unreleased\n\n### Changed\n\n- New change\./);
  assert.ok(changelog.indexOf("## Unreleased") < changelog.indexOf("## 1.0.3"));
});

test("assembleFragments merges repeated and missing section lines into one Added, Changed, Fixed in order", () => {
  const { changelog } = assembleFragments({
    changelog: "# Changelog\n\n## 1.0.3\n\n- Old.\n",
    fragments: [
      { name: "a", content: "### Fixed\n\n- Fix one (#1)\n" },
      { name: "b", content: "- Default change (#2)\n" },
      { name: "c", content: "### Added\n\n- Add one (#3)\n" },
      { name: "d", content: "### Fixed\n\n- Fix two (#4)\n" },
      { name: "e", content: "### Changed\n- Change two (#5)\n" },
    ],
  });
  const section = changelog.slice(changelog.indexOf("## Unreleased"), changelog.indexOf("## 1.0.3"));
  assert.deepEqual(section.match(/^### .*$/gm), ["### Added", "### Changed", "### Fixed"]);
  assert.equal(
    section.trim(),
    "## Unreleased\n\n### Added\n\n- Add one (#3)\n\n### Changed\n\n- Default change (#2)\n- Change two (#5)\n\n### Fixed\n\n- Fix one (#1)\n- Fix two (#4)",
  );
});

test("assembleFragments merges existing Unreleased headings with fragment sections", () => {
  const { changelog } = assembleFragments({
    changelog: "# Changelog\n\n## Unreleased\n\n### Fixed\n- legacy (#9)\n\n## 1.0.3\n\n- Old.\n",
    fragments: [
      { name: "a", content: "### Fixed\n- new fix (#10)\n" },
      { name: "b", content: "### Added\n- new add (#11)\n" },
    ],
  });
  const section = changelog.slice(changelog.indexOf("## Unreleased"), changelog.indexOf("## 1.0.3"));
  assert.deepEqual(section.match(/^### .*$/gm), ["### Added", "### Fixed"]);
  assert.equal(section, "## Unreleased\n\n### Added\n\n- new add (#11)\n\n### Fixed\n\n- legacy (#9)\n- new fix (#10)\n\n");
});

test("assembleFragments fails closed on existing Unreleased content it cannot group", () => {
  const frag = [{ name: "a", content: "- x (#1)\n" }];
  assert.throws(
    () => assembleFragments({ changelog: "## Unreleased\n\n### Security\n- y (#2)\n", fragments: frag }),
    /existing "## Unreleased" section/,
  );
  assert.throws(
    () => assembleFragments({ changelog: "## Unreleased\n\nSome paragraph.\n", fragments: frag }),
    /existing "## Unreleased" section/,
  );
});

test("assembleFragments omits empty section headings", () => {
  const { changelog } = assembleFragments({
    changelog: "# Changelog\n",
    fragments: [{ name: "a", content: "### Fixed\n- Only a fix (#1)\n" }],
  });
  assert.deepEqual(changelog.match(/^### .*$/gm), ["### Fixed"]);
});

test("fragmentFormatErrors names the rule for each violation and passes a conforming fragment", () => {
  assert.deepEqual(fragmentFormatErrors("### Added\n\n- New command (#2429)\n"), []);
  assert.match(fragmentFormatErrors(`- ${"x".repeat(200)} (#1)`).join("\n"), /200-character rule/);
  assert.match(fragmentFormatErrors("- a (#1)\n  more").join("\n"), /one-line rule/);
  assert.match(fragmentFormatErrors("- **b.** a (#1)").join("\n"), /no-bold-lead rule/);
  assert.match(fragmentFormatErrors("- a").join("\n"), /link rule/);
  assert.match(fragmentFormatErrors("### Added\n- a (#1)\n### Fixed\n- b (#2)").join("\n"), /more than one section heading/);
  assert.match(fragmentFormatErrors("- a (#1)\n### Fixed").join("\n"), /section-heading rule/);
  assert.match(fragmentFormatErrors("### Fixed\n").join("\n"), /no entries/);
  assert.match(fragmentFormatErrors("- see (#1) for x").join("\n"), /link rule/);
  assert.match(fragmentFormatErrors("- __Bold__ x (#1)").join("\n"), /no-bold-lead rule/);
  assert.match(fragmentFormatErrors("-  **Bold** x (#1)").join("\n"), /entry-prefix rule/);
  assert.match(fragmentFormatErrors("-  **Bold** x (#1)").join("\n"), /no-bold-lead rule/);
  assert.match(fragmentFormatErrors("- (#1)").join("\n"), /entry-text rule/);
});

test("fragmentFormatErrors pins the 200-character boundary", () => {
  const exactly200 = `- ${"x".repeat(193)} (#1)`;
  assert.equal(exactly200.length, 200);
  assert.deepEqual(fragmentFormatErrors(exactly200), []);
  assert.match(fragmentFormatErrors(`- ${"x".repeat(194)} (#1)`).join("\n"), /200-character rule: entry is 201 characters/);
});

test("assembleFragments files a headingless existing Unreleased entry under Changed, ahead of fragment entries", () => {
  const { changelog } = assembleFragments({
    changelog: "# Changelog\n\n## Unreleased\n\n- existing (#9)\n\n## 1.0.3\n\n- Old.\n",
    fragments: [{ name: "a", content: "- new change (#10)\n" }],
  });
  const section = changelog.slice(changelog.indexOf("## Unreleased"), changelog.indexOf("## 1.0.3"));
  assert.equal(section, "## Unreleased\n\n### Changed\n\n- existing (#9)\n- new change (#10)\n\n");
});

test("unreleasedFormatErrors names the rule for lines assembly cannot group", () => {
  assert.deepEqual(unreleasedFormatErrors("## Unreleased\n\n### Fixed\n- a (#1)\n\n## 1.0.0\n\nold prose\n"), []);
  assert.deepEqual(unreleasedFormatErrors("# Changelog\n"), []);
  assert.match(unreleasedFormatErrors("## Unreleased\n\n* star item\n").join("\n"), /unreleased-line rule/);
  assert.match(unreleasedFormatErrors("## Unreleased\n\n- a\n  wrapped\n").join("\n"), /unreleased-line rule/);
});

test("readFragments fails closed on a fragment that breaks the format, naming its path", () => {
  const root = mkdtempSync(path.join(tmpdir(), "frag-format-"));
  try {
    mkdirSync(path.join(root, "changes"));
    writeFileSync(path.join(root, "changes", "nolink.md"), "- A change with no link\n");
    assert.throws(() => readFragments(root), /changes\/nolink\.md breaks the fragment format: .*link rule/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readFragments reads changes/*.md sorted, skipping README and non-md", () => {
  const root = mkdtempSync(path.join(tmpdir(), "frag-read-"));
  try {
    mkdirSync(path.join(root, "changes"));
    writeFileSync(path.join(root, "changes", "zeta.md"), "- z (#1)\n");
    writeFileSync(path.join(root, "changes", "alpha.md"), "- a (#2)\n");
    writeFileSync(path.join(root, "changes", "README.md"), "docs\n");
    writeFileSync(path.join(root, "changes", "notes.txt"), "nope\n");
    const frags = readFragments(root);
    assert.deepEqual(frags.map((f) => f.name), ["alpha", "zeta"]);
    assert.equal(frags[0].content, "- a (#2)\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readFragments returns [] when the changes/ directory is absent", () => {
  const root = mkdtempSync(path.join(tmpdir(), "frag-none-"));
  try {
    assert.deepEqual(readFragments(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readFragments EXCLUDES a symlinked fragment (never follows it — security policy)", () => {
  // A symlink is not followed: an untrusted PR could point changes/x.md at an
  // arbitrary host file and leak its contents into CHANGELOG.md. Regular files only.
  const root = mkdtempSync(path.join(tmpdir(), "frag-symlink-"));
  try {
    mkdirSync(path.join(root, "changes"));
    writeFileSync(path.join(root, "real-note.md"), "- Linked note.\n");
    writeFileSync(path.join(root, "changes", "real.md"), "- A regular note (#1)\n");
    symlinkSync(path.join(root, "real-note.md"), path.join(root, "changes", "linked.md"));
    const frags = readFragments(root);
    assert.deepEqual(frags.map((f) => f.name), ["real"]); // linked symlink excluded
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fragmentBodyClosesSection flags a level-2 heading but not bullets or level-3 headings", () => {
  assert.equal(fragmentBodyClosesSection("- a note\n- another\n"), false);
  assert.equal(fragmentBodyClosesSection("### Added\n\n- a note\n"), false, "level-3 is allowed");
  assert.equal(fragmentBodyClosesSection("- note with `## inline` code\n"), false, "inline, not line-start");
  assert.equal(fragmentBodyClosesSection("- a note\n## Details\nmore\n"), true, "level-2 heading closes section");
  assert.equal(fragmentBodyClosesSection("## Heading first\n"), true);
});

test("readFragments fails closed on a fragment containing a level-2 heading (would truncate the section)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "frag-heading-"));
  try {
    mkdirSync(path.join(root, "changes"));
    writeFileSync(path.join(root, "changes", "bad.md"), "- a note\n\n## Details\n\n- dropped\n");
    assert.throws(() => readFragments(root), /level-2 "## " heading/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assembleFragments creates an Unreleased section at EOF when the changelog has no headings", () => {
  const { changelog } = assembleFragments({
    changelog: "# Changelog\n\nAll notable changes.\n",
    fragments: [{ name: "x", content: "- New change.\n" }],
  });
  assert.match(changelog, /## Unreleased\n\n### Changed\n\n- New change\./);
});

test("readFragments fails closed when changes/ is a file, not a directory", () => {
  // A `changes` FILE (not a directory): the release must NOT silently treat that
  // as "no fragments" and omit notes.
  const root = mkdtempSync(path.join(tmpdir(), "frag-notdir-"));
  try {
    writeFileSync(path.join(root, "changes"), "not a directory\n");
    assert.throws(() => readFragments(root), /must be a real directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readFragments fails closed when changes/ is a SYMLINK to a directory (never followed)", () => {
  // A commit could replace changes/ with a symlink to an external directory;
  // following it would read/delete arbitrary host files at release. Reject it.
  const root = mkdtempSync(path.join(tmpdir(), "frag-dirlink-"));
  try {
    const external = path.join(root, "external");
    mkdirSync(external);
    writeFileSync(path.join(external, "evil.md"), "- Host data.\n");
    symlinkSync(external, path.join(root, "changes"));
    assert.throws(() => readFragments(root), /must be a real directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// AC evidence: two branches each adding a DISTINCT fragment file merge without a
// CHANGELOG conflict — the core promise of the changeset-fragment approach.
test("two branches each adding a distinct fragment merge without conflict", () => {
  // Scrub GIT_DIR/GIT_WORK_TREE: they override cwd, so a worktree runner that
  // exports either would make git operate on the wrong repository.
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  delete gitEnv.GIT_DIR;
  delete gitEnv.GIT_WORK_TREE;
  const git = (root, ...args) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", env: gitEnv });
  const root = mkdtempSync(path.join(tmpdir(), "frag-merge-"));
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "t@t.t");
    git(root, "config", "user.name", "t");
    mkdirSync(path.join(root, "changes"));
    writeFileSync(path.join(root, "CHANGELOG.md"), CHANGELOG);
    writeFileSync(path.join(root, "changes", "README.md"), "fragments here\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");

    git(root, "checkout", "-q", "-b", "pr-a");
    writeFileSync(path.join(root, "changes", "pr-a.md"), "- Change from PR A.\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "feat: pr a");

    git(root, "checkout", "-q", "main");
    git(root, "checkout", "-q", "-b", "pr-b");
    writeFileSync(path.join(root, "changes", "pr-b.md"), "- Change from PR B.\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "feat: pr b");

    // Merge A into main, then B into main. B was branched before A merged (a
    // stale base) yet touches only its own fragment — no CHANGELOG conflict.
    git(root, "checkout", "-q", "main");
    assert.equal(git(root, "merge", "-q", "--no-edit", "pr-a").status, 0, "PR A merges clean");
    const mergeB = git(root, "merge", "--no-edit", "pr-b");
    assert.equal(mergeB.status, 0, `PR B merges clean without conflict: ${mergeB.stderr}`);

    // Both fragments coexist; CHANGELOG.md never conflicted.
    assert.ok(readFileSync(path.join(root, "changes", "pr-a.md"), "utf8").includes("PR A"));
    assert.ok(readFileSync(path.join(root, "changes", "pr-b.md"), "utf8").includes("PR B"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
