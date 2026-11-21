import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CLASS_ANGLES,
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
  await writeFile(path.join(root, "pr-7", "draft_gate-list.json"), JSON.stringify([{ findings: [{ angle: "kiss", files: ["b.mjs"] }] }]));
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
    assert.deepEqual(summary.byClass, { "edge-case-input-validation": 1, tests: 1 });
    assert.equal(summary.byAngle.coverage, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("classifier maps keywords to classes", () => {
  assert.equal(classifyThreadBody("The stale resume path is split"), "docs-help-description");
  assert.equal(classifyThreadBody("Update the usage text"), "docs-help-description");
  assert.equal(classifyThreadBody("Add an assertion for the fixture"), "tests");
  assert.equal(classifyThreadBody("Rename this variable"), "other");
});

test("fails closed on malformed or missing input", async () => {
  const { dir, root } = await fixture();
  try {
    const bad = path.join(dir, "bad.jsonl");
    await writeFile(bad, '{"pr":7,"path":"a","author":"copilot"}\n{nope\n');
    await assert.rejects(readThreads(bad), /Malformed JSONL/);
    await assert.rejects(readThreads(path.join(dir, "missing.jsonl")), /Cannot read --threads/);
    await assert.rejects(readFindingIndex(path.join(dir, "nope")), /Cannot read --findings-root/);
    assert.throws(() => parseArgsList(["--repo", "a/b"]), /--threads/);
    assert.equal(parseArgsList(["--threads", "t", "--repo", "a/b", "--repo-root", "/r"]).findingsRoot, "/r/tmp/gate-findings/a-b");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("classifier uses the gate-finding-classes bucket order (edge cases first)", () => {
  assert.equal(classifyThreadBody("missing test for X"), "edge-case-input-validation");
  assert.equal(classifyThreadBody("Update the stale docs comment"), "docs-help-description");
  assert.equal(classifyThreadBody("A missing value breaks this"), "edge-case-input-validation");
  assert.equal(classifyThreadBody("This is stale"), "docs-help-description");
  assert.equal(classifyThreadBody(null), "other");
});

test("every class angle exists in extension-defaults.yaml", async () => {
  const yaml = await readFile(path.join(import.meta.dir, "../../packages/core/src/config/extension-defaults.yaml"), "utf8");
  for (const angle of new Set(Object.values(CLASS_ANGLES).flat())) {
    assert.match(yaml, new RegExp(`^\\s*- name: ${angle}$`, "m"), angle);
  }
});

test("accepts singular file, skips non-string files and trims paths", async () => {
  const { dir, root } = await fixture();
  try {
    await writeFile(path.join(root, "pr-7", "draft_gate-single.json"), JSON.stringify({
      findings: [{ angle: "scope", file: " c.md " }, { angle: "x", files: [5, null, "d.md"] }, { files: ["e.md"] }],
    }));
    const index = await readFindingIndex(root);
    const { threads } = matchThreads([
      { pr: 7, path: "c.md", body: "" },
      { pr: 7, path: " d.md", body: "" },
      { pr: 7, path: "e.md", body: "" },
    ], index);
    assert.deepEqual(threads.map((t) => t.matchedAngles), [["scope"], ["x"], []]);
    assert.equal(threads[2].matched, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("empty threads file yields total 0 and wrong-shape lines error", async () => {
  const { dir, root } = await fixture();
  try {
    const empty = path.join(dir, "empty.jsonl");
    await writeFile(empty, "\n\n");
    assert.equal(matchThreads(await readThreads(empty), await readFindingIndex(root)).summary.total, 0);
    const wrong = path.join(dir, "wrong.jsonl");
    await writeFile(wrong, '{"pr":"7","path":"a","author":"copilot"}\n');
    await assert.rejects(readThreads(wrong), /integer pr and a string path/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("skips and counts a malformed round file and ignores a pre_approval_gate file", async () => {
  const { dir, root } = await fixture();
  try {
    await writeFile(path.join(root, "pr-7", "draft_gate-broken.json"), "{");
    await writeFile(path.join(root, "pr-7", "pre_approval_gate-x.json"), JSON.stringify({ findings: [{ angle: "kiss", files: ["z.md"] }] }));
    const result = await readFindingIndex(root);
    assert.equal(result.skipped, 2); // the broken file and the array-shaped fixture file
    const { threads, summary } = matchThreads([{ pr: 7, path: "z.md", body: "" }, { pr: 7, path: "a.md", body: "" }], result);
    assert.deepEqual(threads.map((t) => t.matched), [false, true]);
    assert.equal(summary.skippedRoundFiles, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("drops a non-Copilot thread line and keeps the Copilot reviewer login", async () => {
  const { dir } = await fixture();
  try {
    const file = path.join(dir, "authors.jsonl");
    await writeFile(file, [
      { pr: 7, path: "a", author: "someone" },
      { pr: 7, path: "b", author: "copilot-pull-request-reviewer[bot]" },
      { pr: 7, path: "c" },
    ].map((t) => JSON.stringify(t)).join("\n"));
    assert.deepEqual((await readThreads(file)).map((t) => t.path), ["b"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("makes no gh invocation: a failing gh stub on PATH is never run", async () => {
  const { dir, root } = await fixture();
  try {
    const bin = path.join(dir, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "gh"), `#!/bin/sh\ntouch ${path.join(dir, "gh-ran")}\nexit 1\n`, { mode: 0o755 });
    const threads = path.join(dir, "t.jsonl");
    await writeFile(threads, '{"pr":7,"path":"a.md","author":"copilot","body":"x"}\n');
    const proc = Bun.spawnSync(["node", "scripts/loop/match-copilot-threads-to-gate-findings.mjs", "--threads", threads, "--findings-root", root], {
      cwd: path.join(import.meta.dir, "../.."),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(proc.exitCode, 0);
    assert.equal(existsSync(path.join(dir, "gh-ran")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--findings-root works without --repo; unknown flag exits 2 with a JSON error", async () => {
  assert.equal(parseArgsList(["--threads", "t", "--findings-root", "/f"]).findingsRoot, "/f");
  assert.throws(() => parseArgsList(["--threads", "t"]), /--repo/);
  const proc = Bun.spawnSync(["node", "scripts/loop/match-copilot-threads-to-gate-findings.mjs", "--bogus"], {
    cwd: path.join(import.meta.dir, "../.."),
  });
  assert.equal(proc.exitCode, 2);
  assert.equal(proc.stdout.toString(), "");
  assert.equal(JSON.parse(proc.stderr.toString()).ok, false);
});

test("matches by line window when both sides carry a line, else by file", () => {
  const index = { index: new Map([[7, new Map([["a.mjs", [{ angle: "x", line: 10 }]]])]]) };
  const matched = (thread) => matchThreads([{ pr: 7, ...thread }], index).threads[0].matched;
  assert.equal(matched({ path: "a.mjs", line: 12 }), true);
  assert.equal(matched({ path: "a.mjs" }), true);
  assert.equal(matched({ path: "a.mjs", line: 400 }), false);
  assert.equal(matched({ path: "b.mjs", line: 10 }), false);
});

test("default findings root is main-anchored; --repo is validated like buildLogPath", async () => {
  const { dir } = await fixture();
  try {
    assert.equal(parseArgsList(["--threads", "t", "--repo", "owner/name", "--repo-root", dir]).findingsRoot, path.join(dir, "tmp", "gate-findings", "owner-name"));
    const main = Bun.spawnSync(["git", "init", "-q", "-b", "main", "main"], { cwd: dir });
    assert.equal(main.exitCode, 0);
    const mainDir = path.join(dir, "main");
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i"], { cwd: mainDir });
    const linked = path.join(dir, "linked");
    assert.equal(Bun.spawnSync(["git", "worktree", "add", "-q", "-b", "b", linked], { cwd: mainDir }).exitCode, 0);
    const root = parseArgsList(["--threads", "t", "--repo", "owner/name", "--repo-root", linked]).findingsRoot;
    assert.match(root, new RegExp(`${path.basename(mainDir)}/tmp/gate-findings/owner-name$`));
    assert.ok(!root.includes("linked"));
    for (const bad of ["../x", "a\\b/c", "abc"]) assert.throws(() => parseArgsList(["--threads", "t", "--repo", bad]), /--repo/, bad);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
