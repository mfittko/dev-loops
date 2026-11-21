import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  classifyThreadBody,
  matchThreads,
  parseArgsList,
  readFindingIndex,
  readThreads,
} from "../../scripts/loop/match-copilot-threads-to-gate-findings.mjs";

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "match-threads-"));
  const root = path.join(dir, "findings");
  await mkdir(path.join(root, "pr-7"), { recursive: true });
  await writeFile(path.join(root, "pr-7", "draft_gate-a.json"), JSON.stringify({
    findings: [{ angle: "docs", files: ["a.md"], line: 3, summary: "x" }],
  }));
  await writeFile(path.join(root, "pr-7", "draft_gate-a.seal"), "not json");
  await writeFile(path.join(root, "pr-7", "list.json"), JSON.stringify([{ findings: [{ angle: "kiss", files: ["b.mjs"] }] }]));
  return { dir, root };
}

test("matches by file within the same PR, skipping seal and array files", async () => {
  const { dir, root } = await fixture();
  try {
    const index = await readFindingIndex(root);
    const { threads, summary } = matchThreads([
      { pr: 7, path: "a.md", body: "fix the help text" },
      { pr: 7, path: "b.mjs", body: "value is null here" },
      { pr: 8, path: "a.md", body: "add a test" },
    ], index);
    assert.deepEqual(threads[0].matchedAngles, ["docs"]);
    assert.equal(threads[0].matched, true);
    assert.equal(threads[1].matched, false);
    assert.equal(threads[2].matched, false);
    assert.equal(summary.total, 3);
    assert.equal(summary.copilotOnly, 2);
    assert.deepEqual(summary.byClass, { "input-validation-edge-case": 1, tests: 1 });
    assert.equal(summary.byAngle.coverage, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("classifier maps keywords to classes", () => {
  assert.equal(classifyThreadBody("The stale resume path is split"), "input-validation-edge-case");
  assert.equal(classifyThreadBody("Update the usage text"), "docs-help-description");
  assert.equal(classifyThreadBody("Add an assertion for the fixture"), "tests");
  assert.equal(classifyThreadBody("Rename this variable"), "other");
});

test("fails closed on malformed or missing input", async () => {
  const { dir, root } = await fixture();
  try {
    const bad = path.join(dir, "bad.jsonl");
    await writeFile(bad, '{"pr":7,"path":"a"}\n{nope\n');
    await assert.rejects(readThreads(bad), /Malformed JSONL/);
    await assert.rejects(readThreads(path.join(dir, "missing.jsonl")), /Cannot read --threads/);
    await assert.rejects(readFindingIndex(path.join(dir, "nope")), /Cannot read --findings-root/);
    await writeFile(path.join(root, "pr-7", "broken.json"), "{");
    await assert.rejects(readFindingIndex(root), /Malformed round file/);
    assert.throws(() => parseArgsList(["--repo", "a/b"]), /--threads/);
    assert.equal(parseArgsList(["--threads", "t", "--repo", "a/b", "--repo-root", "/r"]).findingsRoot, "/r/tmp/gate-findings/a-b");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
