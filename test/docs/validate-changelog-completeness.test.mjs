import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  NOTABLE_COMMIT_TYPES,
  extractUnreleasedItems,
  isNotableChange,
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
  it("returns null for non-conventional subjects", () => {
    assert.equal(parseConventionalType("Merge pull request #1864"), null);
    assert.equal(parseConventionalType("random text"), null);
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

  it("counts an item re-added after removal in the same PR as added", () => {
    // Base lacks "New entry"; head has it. Regardless of intermediate churn,
    // head has an item absent from base → satisfied.
    const result = validateChangelogCompleteness({
      baseChangelog: BASE_CHANGELOG,
      headChangelog: headChangelogWith(["New entry"]),
      commitSubjects: ["feat: x"],
      files: [],
    });
    assert.deepEqual(result.errors, []);
  });
});
