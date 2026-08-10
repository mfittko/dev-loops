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

function buildBody({ scope, nonGoals = "", includeSections = true, boundary }) {
  if (!includeSections) {
    return "## Scope\n- owns incomplete\n";
  }
  const scopeLine = boundary ? `- ${boundary}` : `- ${scope}`;
  return [
    "## Scope",
    scopeLine,
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
      { number: 1, parentNumber: null, children: [2, 3], body: buildBody({ scope: "owns orchestration", boundary: "This issue owns orchestration. It does NOT own api (#2) or ui (#3)." }) },
      { number: 2, parentNumber: 1, children: [], body: buildBody({ scope: "owns api", nonGoals: "- not ui -> #3", boundary: "This issue owns api. It does NOT own ui (#3)." }) },
      { number: 3, parentNumber: 1, children: [], body: buildBody({ scope: "owns ui", boundary: "This issue owns ui. It does NOT own api (#2)." }) },
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

function buildNoOwnershipBody() {
  return [
    "## Scope",
    "- no ownership text here",
    "",
    "## Acceptance criteria",
    "- [ ] has acceptance checkbox",
    "",
    "## Definition of done",
    "- [ ] has done checklist",
    "",
    "## Non-goals",
    "- not needed",
    "",
    "## AC / DoD matrix",
    "| Item | Type |",
    "|---|---|",
    "| ac-1 | dod |",
  ].join("\n");
}

test("runRefinementCompletenessChecker flags missing_scope_boundary when ownership prose is absent (AC1)", () => {
  const tree = normalizeTreePayload({
    root: 1,
    issues: [
      { number: 1, children: [], body: buildNoOwnershipBody() },
    ],
  });
  const result = runRefinementCompletenessChecker(tree);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.code === "missing_scope_boundary"));
});

test("runRefinementCompletenessChecker passes with a scope boundary and cross-checker runs against a non-empty claim set (AC2)", () => {
  const tree = normalizeTreePayload({
    root: 1,
    issues: [
      { number: 1, children: [2, 3], body: buildBody({ scope: "owns parent", boundary: "This issue owns parent. It does NOT own shared (#2) or shared (#3)." }) },
      { number: 2, parentNumber: 1, children: [], body: buildBody({ scope: "owns shared", boundary: "This issue owns shared. It does NOT own parent (#1)." }) },
      { number: 3, parentNumber: 1, children: [], body: buildBody({ scope: "owns shared", boundary: "This issue owns shared. It does NOT own parent (#1)." }) },
    ],
  });
  const completeness = runRefinementCompletenessChecker(tree);
  assert.equal(completeness.ok, true, completeness.errors.map((e) => e.message).join("\n"));

  const cross = runScopeBoundaryCrossChecker(tree);
  assert.equal(cross.ok, false);
  assert.ok(cross.errors.some((entry) => entry.code === "duplicate_ownership"));
});

test("runProseLinkageDetector flags duplicate_child_checklist when parent duplicates child checklists (AC3)", () => {
  const body = [
    ...buildBody({ scope: "owns parent", boundary: "This issue owns parent. It does NOT own api (#2) or ui (#3)." }).split("\n"),
    "",
    "## Acceptance criteria",
    "- [ ] #2 implement api",
    "- [ ] #3 implement ui",
  ].join("\n");
  const tree = normalizeTreePayload({
    root: 1,
    issues: [
      { number: 1, children: [2, 3], body },
    ],
  });
  const result = runProseLinkageDetector(tree);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.code === "duplicate_child_checklist"));
});

test("runProseLinkageDetector passes a parent that merely links its children (AC4)", () => {
  const tree = normalizeTreePayload({
    root: 1,
    issues: [
      { number: 1, children: [2, 3], body: buildBody({ scope: "owns parent", boundary: "This issue owns parent. It does NOT own api (#2) or ui (#3)." }) },
    ],
  });
  const result = runProseLinkageDetector(tree);
  assert.ok(!result.errors.some((entry) => entry.code === "duplicate_child_checklist"), result.errors.map((e) => e.message).join("\n"));
});

test("duplicate_child_checklist also fires on a checked child item", () => {
  const body = [
    "## Scope",
    "- This issue owns parent. It does NOT own api (#2).",
    "",
    "## Done",
    "- [x] #2 api complete",
  ].join("\n");
  const tree = normalizeTreePayload({
    root: 1,
    issues: [
      { number: 1, children: [2], body },
    ],
  });
  const result = runProseLinkageDetector(tree);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.code === "duplicate_child_checklist"));
});

test("duplicate_child_checklist does not fire on a single child reference (coverage boundary)", () => {
  const body = [
    "## Scope",
    "- This issue owns parent. It does NOT own api (#2) or ui (#3).",
    "",
    "## Notes",
    "- see #2 for api details",
  ].join("\n");
  const tree = normalizeTreePayload({ root: 1, issues: [{ number: 1, children: [2, 3], body }] });
  const result = runProseLinkageDetector(tree);
  assert.ok(!result.errors.some((entry) => entry.code === "duplicate_child_checklist"), result.errors.map((e) => e.message).join("\n"));
});

test("duplicate_child_checklist does not fire on a boundary bullet with mixed paren/bare child refs", () => {
  const body = [
    "## Scope",
    "- This issue owns parent. It does NOT own api (#2) or ui #3.",
  ].join("\n");
  const tree = normalizeTreePayload({ root: 1, issues: [{ number: 1, children: [2, 3], body }] });
  const result = runProseLinkageDetector(tree);
  assert.ok(!result.errors.some((entry) => entry.code === "duplicate_child_checklist"), result.errors.map((e) => e.message).join("\n"));
});

test("duplicate_child_checklist fires on parenthesized-form child checklist items", () => {
  const body = [
    "## Scope",
    "- This issue owns parent. It does NOT own api (#2) or ui (#3).",
    "",
    "## Acceptance criteria",
    "- [ ] implement api (#2)",
    "- [ ] implement ui (#3)",
  ].join("\n");
  const tree = normalizeTreePayload({ root: 1, issues: [{ number: 1, children: [2, 3], body }] });
  const result = runProseLinkageDetector(tree);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.code === "duplicate_child_checklist"));
});

test("each refusal names the rule it upholds (AC5)", () => {
  const noBoundaryTree = normalizeTreePayload({
    root: 1,
    issues: [{ number: 1, children: [], body: buildNoOwnershipBody() }],
  });
  const completeness = runRefinementCompletenessChecker(noBoundaryTree);
  const missingBoundary = completeness.errors.find((entry) => entry.code === "missing_scope_boundary");
  assert.ok(missingBoundary);
  assert.match(missingBoundary.message, /EPIC-REFINEMENT-REQUIRED-CONTRACTS/);

  const dupBody = [
    "## Scope",
    "- This issue owns parent. It does NOT own api (#2) or ui (#3).",
    "",
    "## Acceptance criteria",
    "- [ ] #2 implement api",
    "- [ ] #3 implement ui",
  ].join("\n");
  const dupTree = normalizeTreePayload({
    root: 1,
    issues: [{ number: 1, children: [2, 3], body: dupBody }],
  });
  const linkage = runProseLinkageDetector(dupTree);
  const dupChecklist = linkage.errors.find((entry) => entry.code === "duplicate_child_checklist");
  assert.ok(dupChecklist);
  assert.match(dupChecklist.message, /SUBISSUE-LEAN-BODY-NO-DUPLICATE/);
});

test("verify FAILS (no vacuous PASS) when ownership prose is absent (DoD regression)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-refine-vacuous-"));
  try {
    const inputPath = await writeFixture(tempDir, "tree.json", {
      root: 1,
      issues: [
        { number: 1, children: [2, 3], body: buildNoOwnershipBody() },
        { number: 2, parentNumber: 1, children: [], body: buildNoOwnershipBody() },
        { number: 3, parentNumber: 1, children: [], body: buildNoOwnershipBody() },
      ],
    });
    const result = await runVerify(["--input", inputPath, "--json"]);
    assert.equal(result.code, 1, result.stderr);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.ok(parsed.errors.some((entry) => entry.code === "missing_scope_boundary"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
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
        stdout: `${JSON.stringify({ number: 1, title: "root", body: buildBody({ scope: "owns orchestration", boundary: "This issue owns orchestration. It does NOT own api (#2)." }), state: "open" })}\n`,
      },
      {
        assertArgs: ["api", "repos/owner/repo/issues/1/sub_issues"],
        stdout: `${JSON.stringify([{ number: 2 }])}\n`,
      },
      {
        assertArgs: ["api", "repos/owner/repo/issues/2"],
        stdout: `${JSON.stringify({ number: 2, title: "child", body: buildBody({ scope: "owns api", boundary: "This issue owns api. It does NOT own orchestration (#1)." }), state: "open" })}\n`,
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
