import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  parseDetectIssueRefinementArtifactCliArgs,
  detectIssueRefinementArtifactFromOptions,
} from "../../scripts/loop/detect-issue-refinement-artifact.mjs";

const scriptPath = path.resolve("scripts/loop/detect-issue-refinement-artifact.mjs");

test("parseDetectIssueRefinementArtifactCliArgs parses --input", () => {
  const opts = parseDetectIssueRefinementArtifactCliArgs(["--input", "/tmp/x.json"]);
  assert.equal(opts.input, "/tmp/x.json");
  assert.equal(opts.repo, undefined);
  assert.equal(opts.issue, undefined);
});

test("parseDetectIssueRefinementArtifactCliArgs parses --repo and --issue", () => {
  const opts = parseDetectIssueRefinementArtifactCliArgs(["--repo", "owner/repo", "--issue", "532"]);
  assert.equal(opts.repo, "owner/repo");
  assert.equal(opts.issue, 532);
});

test("parseDetectIssueRefinementArtifactCliArgs rejects both --input and remote args", () => {
  assert.throws(
    () => parseDetectIssueRefinementArtifactCliArgs(["--input", "/tmp/x.json", "--repo", "owner/repo", "--issue", "1"]),
    /exactly one/i,
  );
});

test("parseDetectIssueRefinementArtifactCliArgs rejects neither --input nor remote args", () => {
  assert.throws(
    () => parseDetectIssueRefinementArtifactCliArgs([]),
    /exactly one/i,
  );
});

test("parseDetectIssueRefinementArtifactCliArgs rejects non-positive issue", () => {
  assert.throws(
    () => parseDetectIssueRefinementArtifactCliArgs(["--repo", "owner/repo", "--issue", "0"]),
    /positive integer/i,
  );
});

test("detectIssueRefinementArtifactFromOptions handles --input with ACs", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "refine-test-"));
  try {
    const input = path.join(tmp, "issue.json");
    await writeFile(
      input,
      JSON.stringify({
        repo: "owner/repo",
        issue: 532,
        body: "## Acceptance criteria\n\n- [ ] First AC\n- [x] Second AC\n\n## AC / DoD matrix\n\n| Criterion outcome | Required completion evidence |\n|---|---|\n| the feature works end to end | a focused test proves the feature works |\n\n## Non-goals\n\n- None.\n",
      }),
      "utf8",
    );
    const result = await detectIssueRefinementArtifactFromOptions({ input });
    assert.equal(result.ok, true);
    assert.equal(result.repo, "owner/repo");
    assert.equal(result.issue, 532);
    assert.equal(result.hasACs, true);
    assert.equal(result.source, "issue-body-matrix");
    assert.deepEqual(result.acItems, ["First AC", "Second AC"]);
    assert.equal(result.finding, null);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("detectIssueRefinementArtifactFromOptions handles --input with prose only", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "refine-test-"));
  try {
    const input = path.join(tmp, "issue.json");
    await writeFile(
      input,
      JSON.stringify({
        repo: "owner/repo",
        issue: 527,
        body: "## Problem\n\nNo ACs here.\n\n## Root Cause\n\nBug.\n",
      }),
      "utf8",
    );
    const result = await detectIssueRefinementArtifactFromOptions({ input });
    assert.equal(result.ok, true);
    assert.equal(result.hasACs, false);
    assert.equal(result.source, "missing");
    assert.equal(result.finding, "missing_refinement_artifact");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("detectIssueRefinementArtifactFromOptions rejects --input with malformed JSON", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "refine-test-"));
  try {
    const input = path.join(tmp, "issue.json");
    await writeFile(input, "not json at all", "utf8");
    await assert.rejects(
      () => detectIssueRefinementArtifactFromOptions({ input }),
      /JSON/i,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
