import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  it("resolves the base via origin/HEAD's default branch first", async () => {
    await withTempChangelog(async (root) => {
      const git = makeFakeGit({ symbolicRef: "refs/remotes/origin/main", mergeBase: "abc123" });
      const log = capturingLog();
      const code = await main({ root, git, env: {}, log });
      assert.equal(code, 0);
      assert.deepEqual(git.mergeBaseCalls, [["origin/main", "HEAD"]]);
    });
  });

  it("falls back to GITHUB_BASE_REF before main/master when origin/HEAD is unavailable", async () => {
    await withTempChangelog(async (root) => {
      const git = makeFakeGit({
        mergeBase(a) {
          return a === "origin/feature-base" ? "def456" : "";
        },
      });
      const log = capturingLog();
      const code = await main({ root, git, env: { GITHUB_BASE_REF: "feature-base" }, log });
      assert.equal(code, 0);
      assert.deepEqual(git.mergeBaseCalls, [["origin/feature-base", "HEAD"]]);
    });
  });

  it("degrades with a notice and exits 0 when no base ref resolves", async () => {
    const git = makeFakeGit({}); // symbolicRef + mergeBase both throw
    const log = capturingLog();
    const code = await main({ root: "/tmp", git, env: {}, log });
    assert.equal(code, 0, "no-history degrade must not fail the check");
    assert.ok(git.mergeBaseCalls.some(([a]) => a === "origin/main"), "candidates were attempted");
    assert.equal(log.lines.length, 1);
    assert.match(log.lines[0], /base ref unavailable/);
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

// --- diffNameOnly: -z (NUL-delimited) paths cannot smuggle a code suffix ---

test("diffNameOnly parses NUL-delimited names (one path per classifyFile() entry)", async () => {
  const calls = [];
  const exec = async (_cmd, args) => {
    calls.push(args);
    return { stdout: "packages/core/src/a.mjs\0packages/core/src/b.mjs\0" };
  };
  const git = createGitClient("/tmp", exec);
  const out = await git.diffNameOnly("base-sha", "HEAD");
  assert.deepEqual(out, ["packages/core/src/a.mjs", "packages/core/src/b.mjs"]);
  const diffCall = calls.find((a) => a.includes("--name-only"));
  assert.ok(diffCall.includes("-z"), "--name-only must use -z so newline-quoted paths cannot hide a code suffix");
});
