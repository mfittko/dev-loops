import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseSpecContextCliArgs,
  specContextChangedPaths,
  specContextExtract,
} from "../../scripts/loop/spec-context.mjs";
import { computeContentDigest, computeSpecDigest, specCriterionIds } from "@dev-loops/core/loop/spec-authority";
import { readSpecAuthorityIdentity } from "../../scripts/lib/spec-authority-stamp.mjs";

const BODY = [
  "## Acceptance criteria",
  "- [ ] Remove repetitive A/B contrast scaffolding",
  "- [ ] Ship a working demo",
  "## Definition of done",
  "- [ ] npm run verify passes",
  "## Non-goals",
  "- Do not flatten the decks' voice or product identity",
].join("\n");

function stubTracker(body = BODY) {
  return {
    getIssue: async ({ repo, id }) => ({
      id,
      title: "Test issue",
      body,
      url: `https://github.com/${repo}/issues/${id}`,
      state: "open",
    }),
  };
}

// --- extract mode ---

test("specContextExtract resolves the spec + both revision-identity digests + criterionIds", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "spec-context-extract-"));
  try {
    const contentPath = path.join(tmpDir, "content.txt");
    await writeFile(contentPath, "reviewed implementation content", "utf8");
    const result = await specContextExtract(
      { repo: "mfittko/dev-loops", issue: 2008, contentFile: "./content.txt", headSha: "a".repeat(40) },
      { repoRoot: tmpDir, tracker: stubTracker() },
    );
    assert.equal(result.ok, true);
    assert.equal(result.repo, "mfittko/dev-loops");
    assert.equal(result.issue, 2008);
    assert.equal(result.spec.acceptanceCriteria.length, 2);
    assert.equal(result.specDigest, computeSpecDigest(result.spec));
    assert.equal(result.contentDigest, computeContentDigest("reviewed implementation content"));
    assert.deepEqual(result.criterionIds, specCriterionIds(result.spec));
    assert.equal(result.headSha, "a".repeat(40));
    assert.equal(result.specOut, undefined);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("specContextExtract writes --spec-out in the shape judge-pass --spec-file expects", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "spec-context-specout-"));
  try {
    await writeFile(path.join(tmpDir, "content.txt"), "impl", "utf8");
    const result = await specContextExtract(
      { repo: "mfittko/dev-loops", issue: 7, contentFile: "./content.txt", specOut: "./spec.json" },
      { repoRoot: tmpDir, tracker: stubTracker() },
    );
    assert.equal(result.specOut, "./spec.json");
    const written = JSON.parse(await readFile(path.join(tmpDir, "spec.json"), "utf8"));
    assert.deepEqual(written, result.spec);
    assert.ok(Array.isArray(written.acceptanceCriteria));
    assert.ok(Array.isArray(written.definitionOfDone));
    assert.ok(Array.isArray(written.nonGoals));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("specContextExtract --identity-out emits the four-field identity stamp {specDigest,headSha,contentDigest,checkedCriteria}", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "spec-context-identity-"));
  try {
    await writeFile(path.join(tmpDir, "content.txt"), "reviewed implementation content", "utf8");
    const result = await specContextExtract(
      {
        repo: "mfittko/dev-loops",
        issue: 2008,
        contentFile: "./content.txt",
        headSha: "a".repeat(40),
        identityOut: "./identity.json",
      },
      { repoRoot: tmpDir, tracker: stubTracker() },
    );
    assert.equal(result.identityOut, "./identity.json");
    const written = JSON.parse(await readFile(path.join(tmpDir, "identity.json"), "utf8"));
    assert.deepEqual(Object.keys(written).sort(), ["checkedCriteria", "contentDigest", "headSha", "specDigest"]);
    assert.equal(written.specDigest, result.specDigest);
    assert.equal(written.headSha, "a".repeat(40));
    assert.equal(written.contentDigest, result.contentDigest);
    assert.deepEqual(written.checkedCriteria, result.criterionIds);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("specContextExtract --identity-out round-trips through a writer's --spec-authority reader", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "spec-context-identity-roundtrip-"));
  try {
    await writeFile(path.join(tmpDir, "content.txt"), "reviewed implementation content", "utf8");
    await specContextExtract(
      {
        repo: "mfittko/dev-loops",
        issue: 2008,
        contentFile: "./content.txt",
        headSha: "b".repeat(40),
        identityOut: "./identity.json",
      },
      { repoRoot: tmpDir, tracker: stubTracker() },
    );
    const identity = await readSpecAuthorityIdentity(
      path.join(tmpDir, "identity.json"),
      (message) => new Error(message),
    );
    assert.equal(identity.headSha, "b".repeat(40));
    assert.ok(Array.isArray(identity.checkedCriteria));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("specContextExtract fails closed on --identity-out without --head-sha", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "spec-context-identity-nohead-"));
  try {
    await writeFile(path.join(tmpDir, "content.txt"), "impl", "utf8");
    await assert.rejects(
      specContextExtract(
        { repo: "mfittko/dev-loops", issue: 1, contentFile: "./content.txt", identityOut: "./identity.json" },
        { repoRoot: tmpDir, tracker: stubTracker() },
      ),
      /--identity-out requires --head-sha/,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("specContextExtract fails closed on an unreadable --content-file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "spec-context-badcontent-"));
  try {
    await assert.rejects(
      specContextExtract(
        { repo: "mfittko/dev-loops", issue: 1, contentFile: "./missing.txt" },
        { repoRoot: tmpDir, tracker: stubTracker() },
      ),
      /Cannot read --content-file/,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("specContextExtract fails closed on a spec with no acceptance criteria (empty tracker body)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "spec-context-nospec-"));
  try {
    await writeFile(path.join(tmpDir, "content.txt"), "impl", "utf8");
    await assert.rejects(
      specContextExtract(
        { repo: "mfittko/dev-loops", issue: 1, contentFile: "./content.txt" },
        { repoRoot: tmpDir, tracker: stubTracker("no structured sections here") },
      ),
      /no acceptance criteria/,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// --- changed-paths mode ---

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_DIR: undefined, GIT_WORK_TREE: undefined },
  });
}

async function makeChangedPathsRepo() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "spec-context-changed-paths-"));
  git(repoRoot, ["init", "-q"]);
  git(repoRoot, ["config", "user.email", "test@example.com"]);
  git(repoRoot, ["config", "user.name", "Test"]);
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(path.join(repoRoot, "src", "a.mjs"), "export const a = 1;\n", "utf8");
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, ["commit", "-q", "-m", "base"]);
  const base = git(repoRoot, ["rev-parse", "HEAD"]).trim();
  await writeFile(path.join(repoRoot, "src", "a.mjs"), "export const a = 2;\n", "utf8");
  await writeFile(path.join(repoRoot, "src", "b.mjs"), "export const b = 1;\n", "utf8");
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, ["commit", "-q", "-m", "delta"]);
  const head = git(repoRoot, ["rev-parse", "HEAD"]).trim();
  return { repoRoot, base, head };
}

test("specContextChangedPaths emits the JSON string array of changed repo-relative paths", async () => {
  const { repoRoot, base, head } = await makeChangedPathsRepo();
  try {
    const result = await specContextChangedPaths({ base, head }, { repoRoot });
    assert.equal(result.ok, true);
    assert.deepEqual(result.changedFiles.sort(), ["src/a.mjs", "src/b.mjs"]);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("specContextChangedPaths resolves --repo-root relative to the caller's repoRoot", async () => {
  const { repoRoot, base, head } = await makeChangedPathsRepo();
  const parent = path.dirname(repoRoot);
  try {
    const result = await specContextChangedPaths({ base, head, repoRoot: path.basename(repoRoot) }, { repoRoot: parent });
    assert.deepEqual(result.changedFiles.sort(), ["src/a.mjs", "src/b.mjs"]);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("specContextChangedPaths fails closed on a leading-'-' --base (ref-shape guard)", async () => {
  const { repoRoot, head } = await makeChangedPathsRepo();
  try {
    await assert.rejects(
      specContextChangedPaths({ base: "-ohno", head }, { repoRoot }),
      /plausible git refs/,
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("specContextChangedPaths fails closed on a '..'-embedding --head (ref-shape guard)", async () => {
  const { repoRoot, base } = await makeChangedPathsRepo();
  try {
    await assert.rejects(
      specContextChangedPaths({ base, head: "HEAD..evil" }, { repoRoot }),
      /plausible git refs/,
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

// --- CLI arg parsing / mode dispatch ---

test("parseSpecContextCliArgs dispatches to extract mode by default", () => {
  const opts = parseSpecContextCliArgs(["--repo", "o/n", "--issue", "1", "--content-file", "c.txt"]);
  assert.equal(opts.mode, "extract");
  assert.equal(opts.repo, "o/n");
  assert.equal(opts.issue, 1);
  assert.equal(opts.contentFile, "c.txt");
});

test("parseSpecContextCliArgs requires --repo/--issue/--content-file in extract mode", () => {
  assert.throws(() => parseSpecContextCliArgs(["--repo", "o/n"]), /extract mode requires/);
});

test("parseSpecContextCliArgs validates --head-sha shape in extract mode", () => {
  assert.throws(
    () => parseSpecContextCliArgs(["--repo", "o/n", "--issue", "1", "--content-file", "c.txt", "--head-sha", "not-a-sha"]),
    /--head-sha must be a 7-64 char hex SHA/,
  );
});

test("parseSpecContextCliArgs dispatches to changed-paths mode on the leading positional", () => {
  const opts = parseSpecContextCliArgs(["changed-paths", "--base", "abc1234", "--head", "def5678"]);
  assert.equal(opts.mode, "changed-paths");
  assert.equal(opts.base, "abc1234");
  assert.equal(opts.head, "def5678");
});

test("parseSpecContextCliArgs requires --base/--head in changed-paths mode", () => {
  assert.throws(() => parseSpecContextCliArgs(["changed-paths", "--base", "abc1234"]), /changed-paths mode requires/);
});

test("parseSpecContextCliArgs accepts --identity-out alongside --head-sha", () => {
  const opts = parseSpecContextCliArgs([
    "--repo", "o/n", "--issue", "1", "--content-file", "c.txt",
    "--head-sha", "a".repeat(40), "--identity-out", "identity.json",
  ]);
  assert.equal(opts.identityOut, "identity.json");
});

test("parseSpecContextCliArgs fails closed on --identity-out without --head-sha", () => {
  assert.throws(
    () => parseSpecContextCliArgs(["--repo", "o/n", "--issue", "1", "--content-file", "c.txt", "--identity-out", "identity.json"]),
    /--identity-out requires --head-sha/,
  );
});

test("parseSpecContextCliArgs fails closed on an unknown extract-mode flag", () => {
  assert.throws(() => parseSpecContextCliArgs(["--repo", "o/n", "--issue", "1", "--content-file", "c.txt", "--bogus"]), /Unknown argument/);
});
