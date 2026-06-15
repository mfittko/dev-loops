import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runNode, writeGhStub } from "../_helpers.mjs";
import { parseRefineVerifyCliArgs } from "../../scripts/refine/verify.mjs";
import { normalizeTreePayload } from "../../scripts/refine/_refine-helpers.mjs";
import { runProseLinkageDetector } from "../../scripts/refine/prose-linkage-detector.mjs";
import { runScopeBoundaryCrossChecker } from "../../scripts/refine/scope-boundary-cross-checker.mjs";
import { runRefinementCompletenessChecker } from "../../scripts/refine/refinement-completeness-checker.mjs";
import { runTreeIntegrityValidator } from "../../scripts/refine/tree-integrity-validator.mjs";

const verifyScriptPath = path.resolve("scripts/refine/verify.mjs");
const cliPath = path.resolve("cli/index.mjs");

const runVerify = (args = [], options = {}) => runNode(verifyScriptPath, args, options);
const runCli = (args = [], options = {}) => runNode(cliPath, args, options);

function buildBody({ scope, nonGoals = "", includeSections = true }) {
  if (!includeSections) {
    return "## Scope\n- owns incomplete\n";
  }
  return [
    "## Scope",
    `- ${scope}`,
    "",
    "## Acceptance criteria",
    "- [ ] has acceptance checkbox",
    "",
    "## Definition of done",
    "- [ ] has done checklist",
    "",
    "## Non-goals",
    nonGoals || "- not needed",
    "",
    "## AC / DoD matrix",
    "| Item | Type |",
    "|---|---|",
    "| ac-1 | dod |",
    "",
  ].join("\n");
}

function buildPassingTreePayload() {
  return {
    root: 1,
    issues: [
      { number: 1, parentNumber: null, children: [2, 3], body: buildBody({ scope: "owns orchestration" }) },
      { number: 2, parentNumber: 1, children: [], body: buildBody({ scope: "owns api", nonGoals: "- not ui -> #3" }) },
      { number: 3, parentNumber: 1, children: [], body: buildBody({ scope: "owns ui" }) },
    ],
  };
}

async function writeFixture(tempDir, name, value) {
  const filePath = path.join(tempDir, name);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

test("parseRefineVerifyCliArgs enforces exactly one mode", () => {
  assert.throws(
    () => parseRefineVerifyCliArgs(["--issue", "7", "--input", "tree.json"]),
    /exactly one of --issue <number> or --input <path>/i,
  );
  assert.throws(
    () => parseRefineVerifyCliArgs([]),
    /exactly one of --issue <number> or --input <path>/i,
  );
});

test("runProseLinkageDetector fails on forbidden prose linkage", () => {
  const tree = normalizeTreePayload({
    root: 1,
    issues: [
      { number: 1, children: [], body: `${buildBody({ scope: "owns root" })}\nChild of #99` },
    ],
  });
  const result = runProseLinkageDetector(tree);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.code === "forbidden_prose_linkage"));
});

test("runScopeBoundaryCrossChecker detects scope gaps and duplicate ownership", () => {
  const tree = normalizeTreePayload({
    root: 1,
    issues: [
      { number: 1, children: [2, 3], body: buildBody({ scope: "owns parent" }) },
      { number: 2, parentNumber: 1, children: [], body: buildBody({ scope: "owns shared", nonGoals: "- not backend -> #3" }) },
      { number: 3, parentNumber: 1, children: [], body: buildBody({ scope: "owns shared" }) },
    ],
  });

  const result = runScopeBoundaryCrossChecker(tree);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.code === "mutual_exclusion_gap"));
  assert.ok(result.errors.some((entry) => entry.code === "duplicate_ownership"));
  assert.ok(result.errors.some((entry) => entry.code === "unowned_scope_gap"));
});

test("runRefinementCompletenessChecker flags missing sections", () => {
  const tree = normalizeTreePayload({
    root: 1,
    issues: [
      { number: 1, children: [], body: buildBody({ scope: "owns root", includeSections: false }) },
    ],
  });

  const result = runRefinementCompletenessChecker(tree);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.code === "missing_acceptance_criteria"));
  assert.ok(result.errors.some((entry) => entry.code === "missing_definition_of_done"));
  assert.ok(result.errors.some((entry) => entry.code === "missing_non_goals"));
  assert.ok(result.errors.some((entry) => entry.code === "missing_ac_dod_matrix"));
});


test("runRefinementCompletenessChecker flags missing checkbox and invalid matrix", () => {
  const body = [
    "## Scope",
    "- owns root",
    "",
    "## Acceptance criteria",
    "no checkbox here",
    "",
    "## Definition of done",
    "- [ ] has done checklist",
    "",
    "## Non-goals",
    "- not needed",
    "",
    "## AC / DoD matrix",
    "no table here",
  ].join("\n");

  const tree = normalizeTreePayload({
    root: 1,
    issues: [
      { number: 1, children: [], body },
    ],
  });

  const result = runRefinementCompletenessChecker(tree);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.code === "missing_acceptance_checkbox"));
  assert.ok(result.errors.some((entry) => entry.code === "invalid_ac_dod_matrix"));
});

test("runTreeIntegrityValidator detects orphans, cycles, and depth violations", () => {
  const tree = normalizeTreePayload({
    root: 1,
    issues: [
      { number: 1, children: [2], body: buildBody({ scope: "owns root" }) },
      { number: 2, parentNumber: 1, children: [3], body: buildBody({ scope: "owns a" }) },
      { number: 3, parentNumber: 2, children: [4], body: buildBody({ scope: "owns b" }) },
      { number: 4, parentNumber: 3, children: [2], body: buildBody({ scope: "owns c" }) },
      { number: 9, parentNumber: 88, children: [], body: buildBody({ scope: "owns orphan" }) },
    ],
  });

  const result = runTreeIntegrityValidator(tree);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.code === "orphaned_issue"));
  assert.ok(result.errors.some((entry) => entry.code === "cycle_detected"));
  assert.ok(result.errors.some((entry) => entry.code === "depth_limit_exceeded"));
});

test("verify script returns exit 0 and checker payload in offline JSON mode", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-refine-verify-pass-"));
  try {
    const inputPath = await writeFixture(tempDir, "tree.json", buildPassingTreePayload());
    const result = await runVerify(["--input", inputPath, "--json"]);
    assert.equal(result.code, 0, result.stderr);

    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.mode, "offline");
    assert.equal(parsed.checkers.length, 4);
    assert.equal(parsed.errors.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("verify script returns human-readable failures and exit 1", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-refine-verify-fail-"));
  try {
    const failingTree = buildPassingTreePayload();
    failingTree.issues[2].body = `${failingTree.issues[2].body}\nParent: #1`;
    const inputPath = await writeFixture(tempDir, "tree.json", failingTree);

    const result = await runVerify(["--input", inputPath]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /refine verify: FAIL/);
    assert.match(result.stdout, /prose-linkage-detector: FAIL/);
    assert.equal(result.stderr, "");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dev-loops refine verify routes through CLI", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-cli-refine-"));
  try {
    const inputPath = await writeFixture(tempDir, "tree.json", buildPassingTreePayload());
    const result = await runCli(["refine", "verify", "--input", inputPath, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("verify script online mode fetches tree via GitHub API", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-refine-verify-online-"));
  try {
    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/issues/1"],
        stdout: `${JSON.stringify({ number: 1, title: "root", body: buildBody({ scope: "owns orchestration" }), state: "open" })}\n`,
      },
      {
        assertArgs: ["api", "repos/owner/repo/issues/1/sub_issues"],
        stdout: `${JSON.stringify([{ number: 2 }])}\n`,
      },
      {
        assertArgs: ["api", "repos/owner/repo/issues/2"],
        stdout: `${JSON.stringify({ number: 2, title: "child", body: buildBody({ scope: "owns api" }), state: "open" })}\n`,
      },
      {
        assertArgs: ["api", "repos/owner/repo/issues/2/sub_issues"],
        stdout: "[]\n",
      },
    ]);

    const result = await runVerify(["--issue", "1", "--repo", "owner/repo", "--json"], { env });
    assert.equal(result.code, 0, result.stderr);

    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.mode, "online");
    assert.equal(parsed.repo, "owner/repo");
    assert.equal(parsed.ok, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("all refine scripts have shebangs", async () => {
  const scripts = [
    "scripts/refine/prose-linkage-detector.mjs",
    "scripts/refine/scope-boundary-cross-checker.mjs",
    "scripts/refine/refinement-completeness-checker.mjs",
    "scripts/refine/tree-integrity-validator.mjs",
    "scripts/refine/verify.mjs",
  ];

  for (const relativePath of scripts) {
    const scriptPath = path.resolve(relativePath);
    const stat = await readFile(scriptPath, "utf8");
    assert.match(stat, /^#!\/usr\/bin\/env node/);
  }
});
