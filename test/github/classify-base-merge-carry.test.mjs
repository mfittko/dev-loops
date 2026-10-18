import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { classifyBaseMergeCarry, validateBaseMergeCarryEvidence } from "@dev-loops/core/loop/base-merge-verdict-carry";
import { computeBaseMergeCarry } from "../../scripts/github/classify-base-merge-carry.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const ok = { sourceHead: A, newHead: B, patchIdBefore: "p1", patchIdAfter: "p1", prDiffPaths: ["src/x.mjs"], baseDeltaPaths: ["docs/y.md"] };

test("pure: carry, partial, full, fallback", () => {
  assert.equal(classifyBaseMergeCarry(ok).decision, "carry_verdict");
  assert.equal(classifyBaseMergeCarry({ ...ok, baseDeltaPaths: ["src/x.mjs"] }).decision, "partial_carry");
  assert.equal(classifyBaseMergeCarry({ ...ok, baseDeltaPaths: [".devloops"] }).decision, "full_regate");
  assert.equal(classifyBaseMergeCarry({ ...ok, baseDeltaPaths: ["skills/docs/gate-review-sub-loop-contract.md"] }).decision, "full_regate");
  assert.equal(classifyBaseMergeCarry({ ...ok, patchIdAfter: "p2" }).decision, "full_regate");
  assert.equal(classifyBaseMergeCarry({ ...ok, conflictResolutionHunks: true }).decision, "full_regate");
  assert.equal(classifyBaseMergeCarry({ ...ok, detectionError: "boom" }).decision, "fallback_full");
  assert.equal(classifyBaseMergeCarry({ ...ok, patchIdBefore: "" }).decision, "fallback_full");
  assert.equal(classifyBaseMergeCarry({ ...ok, newHead: A }).decision, "fallback_full");
});

test("validator: accepts genuine evidence and rejects tampering", () => {
  const ev = classifyBaseMergeCarry(ok);
  assert.equal(validateBaseMergeCarryEvidence(ev).ok, true);
  assert.equal(validateBaseMergeCarryEvidence({ ...ev, patchIdAfter: "p2" }).ok, false);
  assert.equal(validateBaseMergeCarryEvidence({ ...ev, pathIntersection: ["src/x.mjs"] }).ok, false);
  assert.equal(validateBaseMergeCarryEvidence({ ...ev, decision: "bogus" }).ok, false);
  const { reason, ...rest } = ev;
  assert.equal(validateBaseMergeCarryEvidence(rest).ok, false);
  assert.equal(validateBaseMergeCarryEvidence(null).ok, false);
});

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_DIR: undefined, GIT_WORK_TREE: undefined };
const LINES = Array.from({ length: 30 }, (_, i) => `line${i}\n`).join("");
function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bmc-"));
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: dir, env: ENV, encoding: "utf8" }).trim();
  const put = (f, c) => { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), c); };
  git("init", "-q", "-b", "main");
  put("base.txt", LINES);
  git("add", "-A"); git("commit", "-qm", "base");
  git("checkout", "-qb", "pr");
  put("src/x.mjs", "x\n");
  git("add", "-A"); git("commit", "-qm", "pr");
  return { dir, git, put, head: () => git("rev-parse", "HEAD") };
}
function advance(s, file) {
  const prev = s.head();
  s.git("checkout", "-q", "main");
  s.put(file, "changed\n");
  s.git("add", "-A"); s.git("commit", "-qm", "main move");
  s.git("checkout", "-q", "pr");
  s.git("merge", "-q", "--no-edit", "main");
  return computeBaseMergeCarry({ prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir });
}

test("git: unrelated base move carries", async () => {
  const ev = await advance(setup(), "docs/other.md");
  assert.equal(ev.decision, "carry_verdict");
  assert.equal(ev.patchIdBefore, ev.patchIdAfter);
});

test("git: .devloops base move forces full re-gate", async () => {
  const ev = await advance(setup(), ".devloops");
  assert.equal(ev.decision, "full_regate");
  assert.deepEqual(ev.gateToolingPaths, [".devloops"]);
});

test("git: base move touching a PR path is partial", async () => {
  const s = setup();
  s.put("base.txt", `PR\n${LINES.slice(6)}`); s.git("add", "-A"); s.git("commit", "-qm", "pr edits top of base.txt");
  const prev = s.head();
  s.git("checkout", "-q", "main"); s.put("base.txt", `${LINES.slice(0, -7)}MAIN\n`); s.git("add", "-A"); s.git("commit", "-qm", "main edits bottom");
  s.git("checkout", "-q", "pr");
  // distant hunks merge cleanly; the base delta still touches a PR path
  s.git("merge", "-q", "--no-edit", "main");
  const ev = await computeBaseMergeCarry({ prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir });
  assert.equal(ev.decision, "partial_carry", ev.reason);
});

test("git: PR patch changed forces full re-gate", async () => {
  const s = setup();
  const prev = s.head();
  s.put("src/y.mjs", "new logic\n"); s.git("add", "-A"); s.git("commit", "-qm", "more");
  const ev = await computeBaseMergeCarry({ prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir });
  assert.equal(ev.decision, "full_regate");
});

test("git unavailable falls back to full", async () => {
  const runGit = async () => { throw new Error("spawn git ENOENT"); };
  const ev = await computeBaseMergeCarry({ prevHead: A, headSha: B, baseRef: "main", repoRoot: ".", runGit });
  assert.equal(ev.decision, "fallback_full");
  assert.match(ev.reason, /ENOENT/);
});
