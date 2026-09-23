import { describe, it, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  NOTABLE_COMMIT_TYPES,
  createGitClient,
  extractUnreleasedItems,
  isNotableChange,
  main,
  parseConventionalType,
  validateChangelogCompleteness,
} from "../../scripts/docs/validate-changelog-completeness.mjs";

const BASE_CHANGELOG = `# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- Existing entry one
- Existing entry two

## 1.0.0-rc.7 - 2026-08-29

- Old release entry
`;

function headChangelogWith(extraItems) {
  const items = extraItems.length > 0
    ? `\n${extraItems.map((i) => `- ${i}`).join("\n")}\n`
    : "\n";
  return BASE_CHANGELOG.replace(
    "## Unreleased\n\n- Existing entry one",
    `## Unreleased\n${items}- Existing entry one`,
  );
}

describe("parseConventionalType", () => {
  it("detects feat and fix subjects", () => {
    assert.equal(parseConventionalType("feat(gate): add check"), "feat");
    assert.equal(parseConventionalType("fix: repair thing"), "fix");
    assert.equal(parseConventionalType("feat!: breaking change"), "feat");
    assert.equal(parseConventionalType("feat(gate)!: breaking change"), "feat");
  });

  it("detects non-notable types", () => {
    assert.equal(parseConventionalType("chore(release): v1.0.0"), "chore");
    assert.equal(parseConventionalType("docs: clarify contract"), "docs");
  });
  it("rejects an empty scope (guard parity: scope must be non-empty)", () => {
    assert.equal(parseConventionalType("feat(): x"), null);
    assert.equal(parseConventionalType("fix(): x"), null);
  });
  it("returns null for non-conventional subjects", () => {
    assert.equal(parseConventionalType("Merge pull request #1864"), null);
    assert.equal(parseConventionalType("random text"), null);
  });

  it("returns null for near-miss subjects", () => {
    assert.equal(parseConventionalType("wip: x"), null, "wip is not in the guard vocabulary");
    assert.equal(parseConventionalType("FEAT: x"), null, "type must be lowercase");
    assert.equal(parseConventionalType("feat:x"), null, "space after colon is required");
    assert.equal(parseConventionalType(""), null);
  });
});

describe("NOTABLE_COMMIT_TYPES", () => {
  it("contains exactly feat and fix", () => {
    assert.deepEqual([...NOTABLE_COMMIT_TYPES].sort(), ["feat", "fix"]);
  });
});

describe("extractUnreleasedItems", () => {
  it("extracts list items from the Unreleased section only", () => {
    assert.deepEqual(
      extractUnreleasedItems(BASE_CHANGELOG),
      ["Existing entry one", "Existing entry two"],
    );
  });

  it("returns empty list when the section is missing or empty", () => {
    assert.deepEqual(extractUnreleasedItems("# Changelog\n\n## Unreleased\n\n## 1.0.0\n- x\n"), []);
    assert.deepEqual(extractUnreleasedItems("# Changelog\n\n## 1.0.0\n- x\n"), []);
  });

  it("extracts `*` and `+` list markers, not just `-`", () => {
    assert.deepEqual(
      extractUnreleasedItems("## Unreleased\n* Star item\n+ Plus item\n"),
      ["Star item", "Plus item"],
    );
  });

  it("handles CRLF line endings", () => {
    assert.deepEqual(
      extractUnreleasedItems("## Unreleased\r\n- CRLF item\r\n"),
      ["CRLF item"],
    );
  });
});

describe("isNotableChange", () => {
  it("flags a feat subject", () => {
    assert.equal(isNotableChange({ commitSubjects: ["feat(gate): x"], files: ["README.md"] }), true);
  });

  it("flags a fix subject", () => {
    assert.equal(isNotableChange({ commitSubjects: ["fix: x"], files: [] }), true);
  });

  it("flags a code file change even with a chore subject", () => {
    assert.equal(
      isNotableChange({ commitSubjects: ["chore: x"], files: ["packages/core/src/loop/commit-msg-guard.mjs"] }),
      true,
    );
  });

  it("does not flag a docs/chore change with no code files", () => {
    assert.equal(
      isNotableChange({ commitSubjects: ["chore: x"], files: ["skills/docs/pr-lifecycle-contract.md", "package.json"] }),
      false,
    );
    assert.equal(
      isNotableChange({ commitSubjects: ["docs: x"], files: ["docs/guide.md"] }),
      false,
    );
  });

  it("does not flag a test-only change", () => {
    assert.equal(
      isNotableChange({ commitSubjects: ["test: x"], files: ["test/docs/validate-changelog-completeness.test.mjs"] }),
      false,
    );
  });

  it("does not flag ci-only or unknown-category changes (classifier edge categories)", () => {
    assert.equal(
      isNotableChange({ commitSubjects: ["ci: x"], files: [".github/workflows/ci.yml"] }),
      false,
    );
    assert.equal(
      isNotableChange({ commitSubjects: [], files: ["assets/logo.bin"] }),
      false,
    );
  });
});

describe("validateChangelogCompleteness", () => {
  it("fails closed when a notable PR adds no Unreleased item", () => {
    const result = validateChangelogCompleteness({
      baseChangelog: BASE_CHANGELOG,
      headChangelog: BASE_CHANGELOG,
      commitSubjects: ["feat(gate): enforce changelog completeness"],
      files: ["scripts/docs/validate-changelog-completeness.mjs"],
    });
    assert.equal(result.notable, true);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /Unreleased/);
  });

  it("passes when a notable PR adds an Unreleased item", () => {
    const result = validateChangelogCompleteness({
      baseChangelog: BASE_CHANGELOG,
      headChangelog: headChangelogWith(["New entry"]),
      commitSubjects: ["feat(gate): enforce changelog completeness"],
      files: ["scripts/docs/validate-changelog-completeness.mjs"],
    });
    assert.deepEqual(result.errors, []);
  });

  it("does not force a changelog entry on a chore/docs-only PR (no false-fail)", () => {
    const result = validateChangelogCompleteness({
      baseChangelog: BASE_CHANGELOG,
      headChangelog: BASE_CHANGELOG,
      commitSubjects: ["docs: clarify contract"],
      files: ["skills/docs/pr-lifecycle-contract.md"],
    });
    assert.equal(result.notable, false);
    assert.deepEqual(result.errors, []);
  });

  it("treats a reworded item as a diff-level added item", () => {
    // A reword removes one list-item line and adds another in the diff, so it
    // genuinely "adds a list item" under ## Unreleased (issue wording:
    // "the PR diff adds at least one list item").
    const edited = BASE_CHANGELOG.replace(
      "- Existing entry one",
      "- Existing entry one (reworded)",
    );
    const result = validateChangelogCompleteness({
      baseChangelog: BASE_CHANGELOG,
      headChangelog: edited,
      commitSubjects: ["fix: something"],
      files: [],
    });
    assert.equal(result.notable, true);
    assert.deepEqual(result.errors, []);
  });

  it("fails closed when a notable PR removes the Unreleased section entirely", () => {
    const noSection = BASE_CHANGELOG.replace(/^## Unreleased[\s\S]*?(?=## 1\.0\.0)/m, "");
    const result = validateChangelogCompleteness({
      baseChangelog: BASE_CHANGELOG,
      headChangelog: noSection,
      commitSubjects: ["feat: x"],
      files: [],
    });
    assert.equal(result.errors.length, 1);
  });

  it("passes a notable PR that ships ONLY a changeset fragment, with no Unreleased edit (issue #2293)", () => {
    const result = validateChangelogCompleteness({
      baseChangelog: BASE_CHANGELOG,
      headChangelog: BASE_CHANGELOG, // no CHANGELOG.md edit at all
      commitSubjects: ["feat(release): add changeset fragments"],
      files: ["packages/core/src/x.mjs", "changes/2293-changeset-fragments.md"],
      addedFiles: ["changes/2293-changeset-fragments.md"],
    });
    assert.equal(result.notable, true);
    assert.equal(result.addedFragment, true);
    assert.deepEqual(result.errors, []);
  });

  it("does NOT accept a modified/deleted existing fragment as satisfying the gate (only ADDED counts)", () => {
    // The fragment path is in the diff (files) but not in addedFiles — it was
    // modified or deleted, not newly added. The contract requires a NEW fragment.
    const result = validateChangelogCompleteness({
      baseChangelog: BASE_CHANGELOG,
      headChangelog: BASE_CHANGELOG,
      commitSubjects: ["feat: x"],
      files: ["packages/core/src/x.mjs", "changes/old-fragment.md"],
      addedFiles: ["packages/core/src/x.mjs"],
    });
    assert.equal(result.addedFragment, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /changeset fragment/);
  });

  it("does not accept changes/README.md as a fragment (fails closed with no fragment and no Unreleased item)", () => {
    const result = validateChangelogCompleteness({
      baseChangelog: BASE_CHANGELOG,
      headChangelog: BASE_CHANGELOG,
      commitSubjects: ["feat: x"],
      files: ["packages/core/src/x.mjs", "changes/README.md"],
    });
    assert.equal(result.addedFragment, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /changeset fragment/);
  });

  it("counts an item absent from the base section as added (endpoint-based, not churn-based)", () => {
    // Assertion is endpoint-based: the check compares base vs. head Unreleased
    // sections only — it never inspects intermediate churn (an item re-added
    // after removal within the same PR ends in the same head state).
    const result = validateChangelogCompleteness({
      baseChangelog: BASE_CHANGELOG,
      headChangelog: headChangelogWith(["New entry"]),
      commitSubjects: ["feat: x"],
      files: [],
    });
    assert.deepEqual(result.errors, []);
  });
});

// --- main(): git-injected CLI layer (base-ref resolution, degrade, exit codes) ---

/**
 * Fake git client mirroring createGitClient's surface. Records mergeBase calls
 * so tests can pin the base-ref resolution order.
 */
function makeFakeGit({ symbolicRef, mergeBase } = {}, rest = {}) {
  const mergeBaseCalls = [];
  const git = {
    async symbolicRef(ref) {
      if (symbolicRef === undefined) throw new Error("no origin/HEAD");
      return symbolicRef;
    },
    async mergeBase(a, b) {
      mergeBaseCalls.push([a, b]);
      if (typeof mergeBase === "function") return mergeBase(a, b);
      if (typeof mergeBase === "string") return mergeBase;
      throw new Error("fatal: Not a valid object name");
    },
    async logSubjects() {
      return ["chore: x"]; // non-notable default; notable tests override this
    },
    async diffNameOnly() {
      return ["README.md"]; // non-code default; notable tests override this
    },
    async diffAddedFiles() {
      return ["README.md"]; // added-only default; fragment tests override this
    },
    async pathExistsIn() {
      return true;
    },
    async show() {
      return BASE_CHANGELOG;
    },
    mergeBaseCalls,
    ...rest,
  };
  return git;
}

function capturingLog() {
  const lines = [];
  return { lines, log: (...args) => lines.push(args.join(" ")), error: (...args) => lines.push(args.join(" ")) };
}

async function withTempChangelog(fn, changelog = BASE_CHANGELOG) {
  const root = await mkdtemp(path.join(tmpdir(), "changelog-gate-"));
  try {
    await writeFile(path.join(root, "CHANGELOG.md"), changelog, "utf8");
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("main()", () => {
  // base-ref candidate order (origin/HEAD -> GITHUB_BASE_REF -> main -> master)
  // is now owned by the shared resolveBaseRef test in
  // test/docs/_doc-git-client.test.mjs; these caller tests keep only the
  // validator's own policy (degrade notice, exit codes) and diffNameOnly behavior.
  it("degrades with a notice and exits 0 when no base ref resolves", async () => {
    const git = makeFakeGit({}); // symbolicRef + mergeBase both throw
    const log = capturingLog();
    const code = await main({ root: "/tmp", git, env: {}, log });
    assert.equal(code, 0, "no-history degrade must not fail the check");
    assert.ok(git.mergeBaseCalls.some(([a]) => a === "origin/main"), "candidates were attempted");
    assert.equal(log.lines.length, 1);
    assert.match(log.lines[0], /base ref unavailable/);
  });

  it("accepts an ADDED non-empty fragment but not a modified or empty one", async () => {
    // Added + non-empty: passes.
    await withTempChangelog(async (root) => {
      const dir = path.join(root, "changes");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "new.md"), "- A real note. (#1)\n", "utf8");
      const added = makeFakeGit({ symbolicRef: "refs/remotes/origin/main", mergeBase: "abc123" }, {
        logSubjects: async () => ["feat: x"],
        diffNameOnly: async () => ["packages/core/src/x.mjs", "changes/new.md"],
        diffAddedFiles: async () => ["packages/core/src/x.mjs", "changes/new.md"],
      });
      assert.equal(await main({ root, git: added, env: {}, log: capturingLog() }), 0);
    });
    // Fragment path only modified (not in addedFiles): fails.
    await withTempChangelog(async (root) => {
      const modified = makeFakeGit({ symbolicRef: "refs/remotes/origin/main", mergeBase: "abc123" }, {
        logSubjects: async () => ["feat: x"],
        diffNameOnly: async () => ["packages/core/src/x.mjs", "changes/old.md"],
        diffAddedFiles: async () => ["packages/core/src/x.mjs"],
      });
      assert.equal(await main({ root, git: modified, env: {}, log: capturingLog() }), 1);
    });
    // Added but EMPTY fragment: rejected (path present, no note).
    await withTempChangelog(async (root) => {
      const dir = path.join(root, "changes");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "blank.md"), "   \n", "utf8");
      const empty = makeFakeGit({ symbolicRef: "refs/remotes/origin/main", mergeBase: "abc123" }, {
        logSubjects: async () => ["feat: x"],
        diffNameOnly: async () => ["packages/core/src/x.mjs", "changes/blank.md"],
        diffAddedFiles: async () => ["packages/core/src/x.mjs", "changes/blank.md"],
      });
      assert.equal(await main({ root, git: empty, env: {}, log: capturingLog() }), 1);
    });
    // Added SYMLINK fragment: rejected (never followed — security policy).
    await withTempChangelog(async (root) => {
      const dir = path.join(root, "changes");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(root, "secret.md"), "- Host data.\n", "utf8");
      await symlink(path.join(root, "secret.md"), path.join(dir, "linked.md"));
      const linked = makeFakeGit({ symbolicRef: "refs/remotes/origin/main", mergeBase: "abc123" }, {
        logSubjects: async () => ["feat: x"],
        diffNameOnly: async () => ["packages/core/src/x.mjs", "changes/linked.md"],
        diffAddedFiles: async () => ["packages/core/src/x.mjs", "changes/linked.md"],
      });
      assert.equal(await main({ root, git: linked, env: {}, log: capturingLog() }), 1);
    });
    // Added fragment with a level-2 "## " heading: rejected (would truncate section).
    await withTempChangelog(async (root) => {
      const dir = path.join(root, "changes");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "bad.md"), "- a note\n\n## Details\n\n- dropped\n", "utf8");
      const bad = makeFakeGit({ symbolicRef: "refs/remotes/origin/main", mergeBase: "abc123" }, {
        logSubjects: async () => ["feat: x"],
        diffNameOnly: async () => ["packages/core/src/x.mjs", "changes/bad.md"],
        diffAddedFiles: async () => ["packages/core/src/x.mjs", "changes/bad.md"],
      });
      assert.equal(await main({ root, git: bad, env: {}, log: capturingLog() }), 1);
    });
  });

  it("exits 1 when a notable change adds no Unreleased item, 0 otherwise", async () => {
    await withTempChangelog(async (root) => {
      const failing = makeFakeGit({ symbolicRef: "refs/remotes/origin/main", mergeBase: "abc123" }, {
        logSubjects: async () => ["feat(gate): enforce changelog completeness"],
        diffNameOnly: async () => ["packages/core/src/x.mjs"],
      });
      const log = capturingLog();
      assert.equal(await main({ root, git: failing, env: {}, log }), 1);
      assert.ok(log.lines.some((l) => l.includes("CHANGELOG completeness check failed")));
    });
    await withTempChangelog(async (root) => {
      const passing = makeFakeGit({ symbolicRef: "refs/remotes/origin/main", mergeBase: "abc123" }, {
        logSubjects: async () => ["feat(gate): enforce changelog completeness"],
        diffNameOnly: async () => ["packages/core/src/x.mjs"],
      });
      passing.show = async () => BASE_CHANGELOG; // base lacks the added item
      const log2 = capturingLog();
      assert.equal(await main({ root, git: passing, env: {}, log: log2 }), 0);
      assert.ok(log2.lines.some((l) => l.includes("check passed")));
    }, headChangelogWith(["New entry"]));
  });
});

// --- fragment format rule: one-line entries, 200 chars, no bold lead, a link, one section ---

async function runWithFragment(body, { added = true, changelog } = {}) {
  let result;
  await withTempChangelog(async (root) => {
    await mkdir(path.join(root, "changes"), { recursive: true });
    await writeFile(path.join(root, "changes", "frag.md"), body, "utf8");
    const git = makeFakeGit({ symbolicRef: "refs/remotes/origin/main", mergeBase: "abc123" }, {
      logSubjects: async () => ["feat: x"],
      diffNameOnly: async () => ["packages/core/src/x.mjs", "changes/frag.md"],
      diffAddedFiles: async () => (added ? ["packages/core/src/x.mjs", "changes/frag.md"] : ["packages/core/src/x.mjs"]),
    });
    const log = capturingLog();
    const code = await main({ root, git, env: {}, log });
    result = { code, output: log.lines.join("\n") };
  }, changelog);
  return result;
}

describe("fragment format rule", () => {
  it("passes a conforming fragment", async () => {
    const { code, output } = await runWithFragment("### Fixed\n\n- Merge no longer passes without a review (#2429)\n- Another fix (#1, #2)\n");
    assert.equal(code, 0, output);
  });

  it("passes a conforming fragment with no section line (default Changed)", async () => {
    assert.equal((await runWithFragment("- Release notes are one line per change (#2429)\n")).code, 0);
  });

  const cases = [
    ["an entry over 200 characters", `- ${"x".repeat(200)} (#1)\n`, /200-character rule/],
    ["a continuation line", "- A change (#1)\n  that wraps onto a second line\n", /one-line rule/],
    ["a bold lead", "- **Bold lead.** A change (#1)\n", /no-bold-lead rule/],
    ["a missing link", "- A change with no link\n", /link rule/],
    ["two section headings", "### Added\n\n- A (#1)\n\n### Fixed\n\n- B (#2)\n", /section-heading rule/],
  ];
  for (const [name, body, rule] of cases) {
    it(`rejects ${name} with a message naming the rule`, async () => {
      const { code, output } = await runWithFragment(body);
      assert.equal(code, 1);
      assert.match(output, rule);
      assert.match(output, /changes\/frag\.md/);
    });
  }

  it("checks a modified (not only added) fragment", async () => {
    const { code, output } = await runWithFragment("- **Bold.** x (#1)\n", { added: false });
    assert.equal(code, 1);
    assert.match(output, /no-bold-lead rule/);
  });

  it("rejects a fragment in the diff that is a symlink at HEAD with a named error", async () => {
    await withTempChangelog(async (root) => {
      await mkdir(path.join(root, "changes"), { recursive: true });
      await writeFile(path.join(root, "changes", "new.md"), "- Conforming note (#3)\n", "utf8");
      await writeFile(path.join(root, "target.md"), "- Linked note (#4)\n", "utf8");
      await symlink(path.join(root, "target.md"), path.join(root, "changes", "linked.md"));
      const git = makeFakeGit({ symbolicRef: "refs/remotes/origin/main", mergeBase: "abc123" }, {
        logSubjects: async () => ["feat: x"],
        diffNameOnly: async () => ["packages/core/src/x.mjs", "changes/linked.md", "changes/new.md"],
        diffAddedFiles: async () => ["packages/core/src/x.mjs", "changes/new.md"],
      });
      const log = capturingLog();
      assert.equal(await main({ root, git, env: {}, log }), 1);
      assert.match(log.lines.join("\n"), /changes\/linked\.md: regular-file rule/);
    });
  });

  it("does not re-check consumed history in CHANGELOG.md or deleted fragments", async () => {
    const legacy = BASE_CHANGELOG.replace(
      "## 1.0.0-rc.7",
      "## 1.0.0-rc.8\n\n### Fixed\n\n- **Bold legacy entry.** wraps\n  onto a continuation line\n\n### Fixed\n\n## 1.0.0-rc.7",
    );
    await withTempChangelog(async (root) => {
      await mkdir(path.join(root, "changes"), { recursive: true });
      await writeFile(path.join(root, "changes", "new.md"), "- Conforming note (#3)\n", "utf8");
      const git = makeFakeGit({ symbolicRef: "refs/remotes/origin/main", mergeBase: "abc123" }, {
        logSubjects: async () => ["feat: x"],
        // changes/consumed.md is in the diff (deleted at release) but absent at HEAD.
        diffNameOnly: async () => ["packages/core/src/x.mjs", "CHANGELOG.md", "changes/consumed.md", "changes/new.md"],
        diffAddedFiles: async () => ["packages/core/src/x.mjs", "changes/new.md"],
      });
      const log = capturingLog();
      assert.equal(await main({ root, git, env: {}, log }), 0, log.lines.join("\n"));
    }, legacy);
  });
});

// --- diffNameOnly: -z (NUL-delimited) paths cannot smuggle a code suffix ---

test("diffNameOnly parses NUL-delimited names (one path per classifyFile() entry)", async () => {
  const calls = [];
  const exec = async (_cmd, args) => {
    calls.push(args);
    return { stdout: "packages/core/src/a.mjs\0packages/core/src/b.mjs\0" };
  };
  const git = createGitClient("/tmp", exec);
  const out = await git.diffNameOnly("base-sha", "HEAD", { nulDelimited: true });
  assert.deepEqual(out, ["packages/core/src/a.mjs", "packages/core/src/b.mjs"]);
  const diffCall = calls.find((a) => a.includes("--name-only"));
  assert.ok(diffCall.includes("-z"), "--name-only must use -z so newline-quoted paths cannot hide a code suffix");
});

test("diffAddedFiles invokes --diff-filter=A --name-only -z and parses NUL-delimited added paths", async () => {
  // The added-only enforcement seam: a regression in these flags or the NUL
  // parsing would leave the gate accepting modified/deleted fragments while
  // fake-git unit tests stay green. Assert the real createGitClient invocation.
  const calls = [];
  const exec = async (_cmd, args) => {
    calls.push(args);
    return { stdout: "changes/new.md\0packages/core/src/a.mjs\0" };
  };
  const git = createGitClient("/tmp", exec);
  const out = await git.diffAddedFiles("base-sha", "HEAD", { nulDelimited: true });
  assert.deepEqual(out, ["changes/new.md", "packages/core/src/a.mjs"]);
  const call = calls.find((a) => a.includes("--name-only"));
  assert.ok(call.includes("--diff-filter=A"), "must restrict to ADDED paths");
  assert.ok(call.includes("-z"), "must be NUL-delimited");
  assert.ok(call.includes("--find-renames"), "rename detection ON so a git-mv fragment is R (excluded), not A");
  assert.ok(!call.includes("--no-renames"), "must NOT disable rename detection on the added-only query");
  assert.deepEqual(call.slice(-2), ["base-sha", "HEAD"], "diffs base...HEAD in order");
});
