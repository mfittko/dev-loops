import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectMarkdownFiles,
  extractSentences,
  isImperativeSentence,
  normalizeSentence,
  scanSkills,
} from "../../scripts/docs/validate-no-duplicate-rules.mjs";

async function writeSkillsDir(tempDir, files) {
  const skillsDir = path.join(tempDir, "skills");
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(skillsDir, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, `${content}\n`, "utf8");
  }
  return skillsDir;
}

test("isImperativeSentence detects must/never/do not/require", () => {
  assert.ok(isImperativeSentence("You must always run tests before every push."));
  assert.ok(isImperativeSentence("Never push directly to the main branch."));
  assert.ok(isImperativeSentence("Do not bypass the gate check mechanism."));
  assert.ok(isImperativeSentence("This step requires explicit verification."));
  assert.ok(isImperativeSentence("Required startup reads are listed below."));
  assert.ok(!isImperativeSentence("This is a simple statement."));
  assert.ok(!isImperativeSentence("Hello world."));
});

test("normalizeSentence collapses whitespace", () => {
  assert.equal(normalizeSentence("  hello   world  "), "hello world");
  assert.equal(normalizeSentence("line1\nline2"), "line1 line2");
  assert.equal(normalizeSentence("a\tb"), "a b");
});

test("extractSentences finds imperative sentences", () => {
  const result = extractSentences("You must run tests before every push. This is optional.");
  assert.equal(result.length, 1);
  assert.ok(result[0].text.includes("must"));
});

test("extractSentences finds multiple imperative sentences in line", () => {
  const result = extractSentences("You must always lint. Never skip verification.");
  assert.equal(result.length, 2);
});

test("extractSentences skips short imperative fragments", () => {
  // "Must do." is only 7 chars after normalization — below MIN_SENTENCE_LENGTH
  const result = extractSentences("Must do.");
  assert.equal(result.length, 0);
});

test("extractSentences skips fenced code blocks", () => {
  const content = [
    "You must check the configuration before every run.",
    "```",
    "You must also check this inside code block.",
    "```",
    "Normal text after block.",
  ].join("\n");
  const result = extractSentences(content);
  const texts = result.map((s) => s.text);
  assert.ok(texts.some((t) => t.includes("configuration")));
  const codeContent = texts.filter((t) => t.includes("inside code"));
  assert.equal(codeContent.length, 0);
});

test("extractSentences skips inline code", () => {
  const result = extractSentences("Run `npm test --must-flag` before every push and always must verify.");
  assert.equal(result.length, 1);
  assert.ok(!result[0].text.includes("npm test"));
});

test("extractSentences skips markdown link URLs", () => {
  const result = extractSentences(
    "See [the guide about required steps](https://example.com/must-read) for details. You must read the full documentation guide."
  );
  // Both sentences contain imperative keywords; link URLs removed
  assert.equal(result.length, 2);
  assert.ok(result.some((s) => s.text.includes("must read")));
});

test("extractSentences skips blockquote lines", () => {
  const content = [
    "> You must follow this quoted rule in the block.",
    "You must follow the non-quoted actual rule.",
  ].join("\n");
  const result = extractSentences(content);
  assert.equal(result.length, 1);
  assert.equal(result[0].text, "You must follow the non-quoted actual rule.");
});

test("extractSentences skips headings", () => {
  const content = [
    "# Required Startup Reads and Configuration",
    "You must read the documentation before starting.",
  ].join("\n");
  const result = extractSentences(content);
  assert.equal(result.length, 1);
  assert.ok(result[0].text.includes("read the documentation"));
});

test("extractSentences preserves line numbers", () => {
  const content = [
    "First line is just filler.",
    "You must check configuration before every push.",
  ].join("\n");
  const result = extractSentences(content);
  assert.equal(result[0].line, 2);
});

test("extractSentences handles ~~~ fenced blocks", () => {
  const content = [
    "You must check outside block.",
    "~~~",
    "You must ignore this inside tilde block.",
    "~~~",
    "Normal text after tilde block.",
  ].join("\n");
  const result = extractSentences(content);
  const texts = result.map((s) => s.text);
  assert.ok(texts.some((t) => t.includes("outside block")));
  assert.ok(!texts.some((t) => t.includes("tilde block")));
});

test("scanSkills detects cross-file duplicates", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-validate-rules-"));
  try {
    const skillsDir = await writeSkillsDir(tempDir, {
      "doc-a/SKILL.md": "You must always run tests before pushing changes to main.",
      "doc-b/SKILL.md": "You must always run tests before pushing changes to main. Another unique statement.",
    });
    const repoRoot = tempDir;
    const { fileMap, duplicates } = await scanSkills(skillsDir, repoRoot);

    assert.equal(duplicates.size, 1);
    const dupEntries = [...duplicates.entries()];
    assert.equal(dupEntries[0][0], "You must always run tests before pushing changes to main.");
    assert.equal(dupEntries[0][1].length, 2);

    const files = new Set(dupEntries[0][1].map((o) => o.file));
    assert.ok(files.has("skills/doc-a/SKILL.md"));
    assert.ok(files.has("skills/doc-b/SKILL.md"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("scanSkills reports no duplicates when clean", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-validate-rules-"));
  try {
    const skillsDir = await writeSkillsDir(tempDir, {
      "doc-a/SKILL.md": "You must run tests before pushing changes to the branch.",
      "doc-b/SKILL.md": "You must check lint before merging to main branch.",
    });
    const repoRoot = tempDir;
    const { duplicates } = await scanSkills(skillsDir, repoRoot);

    assert.equal(duplicates.size, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("scanSkills detects duplicate across three files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-validate-rules-"));
  try {
    const skillsDir = await writeSkillsDir(tempDir, {
      "doc-a/SKILL.md": "You must always run tests before pushing to main.",
      "doc-b/SKILL.md": "You must always run tests before pushing to main.",
      "doc-c/SKILL.md": "You must always run tests before pushing to main.",
    });
    const repoRoot = tempDir;
    const { duplicates } = await scanSkills(skillsDir, repoRoot);

    assert.equal(duplicates.size, 1);
    const dupEntries = [...duplicates.entries()];
    assert.equal(dupEntries[0][1].length, 3);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("scanSkills ignores same-file duplicates", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-validate-rules-"));
  try {
    const skillsDir = await writeSkillsDir(tempDir, {
      "doc-a/SKILL.md": "You must run tests before pushing. You must run tests before pushing.",
      "doc-b/SKILL.md": "Different content goes here for this file.",
    });
    const repoRoot = tempDir;
    const { duplicates } = await scanSkills(skillsDir, repoRoot);

    assert.equal(duplicates.size, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("scanSkills handles empty skills tree", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-validate-rules-"));
  try {
    const skillsDir = path.join(tempDir, "skills");
    await mkdir(skillsDir, { recursive: true });
    const repoRoot = tempDir;
    const { fileMap, duplicates } = await scanSkills(skillsDir, repoRoot);

    assert.equal(fileMap.size, 0);
    assert.equal(duplicates.size, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("scanSkills detects duplicate when non-canonical file restates canonical rule", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-validate-rules-"));
  try {
    const skillsDir = await writeSkillsDir(tempDir, {
      "docs/copilot-loop-operations.md": "You must run tests before every push to main and also verify the build output is correct.",
      "doc-a/SKILL.md": "You must run tests before every push to main and also verify the build output is correct.",
    });
    const repoRoot = tempDir;
    const { duplicates } = await scanSkills(skillsDir, repoRoot);

    // Non-canonical file duplicated a canonical rule: cross-file duplicate detected
    assert.equal(duplicates.size, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("scanSkills suppresses duplicates when all occurrences are canonical", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-validate-rules-"));
  try {
    const skillsDir = await writeSkillsDir(tempDir, {
      "docs/copilot-loop-operations.md": "You must run tests before every push to main and also verify the build output is correct.",
      "docs/public-dev-loop-contract.md": "You must run tests before every push to main and also verify the build output is correct.",
    });
    const repoRoot = tempDir;
    const { duplicates } = await scanSkills(skillsDir, repoRoot);

    // Both occurrences are in canonical contract docs — suppressed
    assert.equal(duplicates.size, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("scanSkills excludes known intentional duplicates", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-validate-rules-"));
  try {
    // This sentence is in the KNOWN_INTENTIONAL_DUPLICATES set,
    // so cross-file duplication should be suppressed.
    const skillsDir = await writeSkillsDir(tempDir, {
      "doc-a/SKILL.md": "If any required bundled contract doc is missing from the installed skill layout, treat that as a packaging/installer bug.",
      "doc-b/SKILL.md": "If any required bundled contract doc is missing from the installed skill layout, treat that as a packaging/installer bug.",
    });
    const repoRoot = tempDir;
    const { duplicates } = await scanSkills(skillsDir, repoRoot);

    assert.equal(duplicates.size, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("collectMarkdownFiles finds markdown files recursively", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-validate-rules-"));
  try {
    const skillsDir = await writeSkillsDir(tempDir, {
      "SKILL.md": "root",
      "docs/contract.md": "contract",
      "nested/deep/README.md": "nested",
    });

    const files = [];
    for await (const f of collectMarkdownFiles(skillsDir, tempDir)) {
      files.push(f);
    }

    assert.equal(files.length, 3);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
