import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { classifyBaseMergeCarry, validateBaseMergeCarryEvidence } from "@dev-loops/core/loop/base-merge-verdict-carry";
import { buildBaseMergeCarryPath, computeBaseMergeCarry, main } from "../../scripts/github/classify-base-merge-carry.mjs";

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
  assert.equal(validateBaseMergeCarryEvidence({ ...ev, reason: "edited" }).ok, false);
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
  assert.equal(ev.decision, "carry_verdict", ev.reason);
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

test("git: ambient GIT_DIFF_OPTS does not change the decision or patch ids", async () => {
  const s = setup();
  s.put("base.txt", `PR\n${LINES.slice(6)}`); s.git("add", "-A"); s.git("commit", "-qm", "pr edits top of base.txt");
  const prev = s.head();
  s.git("checkout", "-q", "main"); s.put("base.txt", `${LINES.slice(0, -7)}MAIN\n`); s.git("add", "-A"); s.git("commit", "-qm", "main edits bottom");
  s.git("checkout", "-q", "pr"); s.git("merge", "-q", "--no-edit", "main");
  const args = { prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir };
  const clean = await computeBaseMergeCarry(args);
  const saved = process.env.GIT_DIFF_OPTS;
  process.env.GIT_DIFF_OPTS = "-u0";
  try { assert.deepEqual(await computeBaseMergeCarry(args), clean); } finally { if (saved === undefined) delete process.env.GIT_DIFF_OPTS; else process.env.GIT_DIFF_OPTS = saved; }
});

test("git: ambient GIT_ATTR_SOURCE with a -diff attribute does not change the decision or patch ids", async () => {
  const s = setup();
  s.put("base.txt", `PR\n${LINES.slice(6)}`); s.git("add", "-A"); s.git("commit", "-qm", "pr edits top of base.txt");
  const prev = s.head();
  s.git("checkout", "-q", "main"); s.put("base.txt", `${LINES.slice(0, -7)}MAIN\n`); s.git("add", "-A"); s.git("commit", "-qm", "main edits bottom");
  s.git("checkout", "-q", "pr"); s.git("merge", "-q", "--no-edit", "main");
  s.git("checkout", "-qb", "attrs"); s.put(".gitattributes", "* -diff\n"); s.git("add", "-A"); s.git("commit", "-qm", "attrs");
  s.git("checkout", "-q", "pr");
  const args = { prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir };
  const clean = await computeBaseMergeCarry(args);
  const saved = process.env.GIT_ATTR_SOURCE;
  process.env.GIT_ATTR_SOURCE = "attrs";
  try { assert.deepEqual(await computeBaseMergeCarry(args), clean); } finally { if (saved === undefined) delete process.env.GIT_ATTR_SOURCE; else process.env.GIT_ATTR_SOURCE = saved; }
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

test("git: indentation-only PR change forces full re-gate", async () => {
  const s = setup();
  s.put("ci.yml", "a:\n  b: 1\n"); s.git("add", "-A"); s.git("commit", "-qm", "yaml");
  const prev = s.head();
  s.put("ci.yml", "a:\n    b: 1\n"); s.git("add", "-A"); s.git("commit", "-qm", "reindent");
  const ev = await computeBaseMergeCarry({ prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir });
  assert.equal(ev.decision, "full_regate");
});

test("git: non-ancestor prev head falls back to full", async () => {
  const s = setup();
  const head = s.head();
  s.git("checkout", "-q", "main"); s.put("docs/other.md", "changed\n"); s.git("add", "-A"); s.git("commit", "-qm", "main after branch point");
  const ev = await computeBaseMergeCarry({ prevHead: s.head(), headSha: head, baseRef: "main", repoRoot: s.dir });
  assert.equal(ev.decision, "fallback_full");
  assert.match(ev.reason, /not an ancestor/);
});

test("git: lossy textconv cannot hide a PR content change", async () => {
  const s = setup();
  s.put(".gitattributes", "*.dat diff=lossy\n"); s.put("f.dat", "abcXXX\n"); s.git("add", "-A"); s.git("commit", "-qm", "dat");
  s.git("config", "diff.lossy.textconv", "head -c 3");
  const prev = s.head();
  s.put("f.dat", "abcYYY\n"); s.git("add", "-A"); s.git("commit", "-qm", "change dat");
  const ev = await computeBaseMergeCarry({ prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir });
  assert.equal(ev.decision, "full_regate");
});

test("git: base-side conflict-resolved merge still carries", async () => {
  const s = setup();
  s.git("checkout", "-q", "main"); s.put("o.txt", LINES); s.git("add", "-A"); s.git("commit", "-qm", "add o");
  s.git("checkout", "-qb", "other");
  s.put("o.txt", `OTHER\n${LINES.slice(6)}`); s.git("add", "-A"); s.git("commit", "-qm", "other edits o");
  s.git("checkout", "-q", "main"); s.put("o.txt", `MAIN\n${LINES.slice(6)}`); s.git("add", "-A"); s.git("commit", "-qm", "main edits o");
  s.git("checkout", "-q", "other");
  try { s.git("merge", "--no-edit", "main"); } catch { /* conflict expected */ }
  s.put("o.txt", `OTHER\nMAIN\n${LINES.slice(6)}`); s.git("add", "-A"); s.git("commit", "-qm", "resolve");
  s.git("checkout", "-q", "main"); s.git("merge", "-q", "--no-ff", "--no-edit", "other");
  s.git("checkout", "-q", "pr");
  const prev = s.head();
  s.git("merge", "-q", "--no-edit", "main");
  const ev = await computeBaseMergeCarry({ prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir });
  assert.equal(ev.conflictResolutionHunks, false);
  assert.equal(ev.decision, "carry_verdict");
});

test("gate tooling covers agent mirrors and lockfiles", () => {
  for (const p of [".claude/skills/x.md", "package-lock.json", "packages/core/src/foo/bar.mjs", "schemas/a.json", "extension/readonly-role-gate.ts", "commands/loop-review.command.md", "AGENTS.md", "bunfig.toml"]) {
    assert.equal(classifyBaseMergeCarry({ ...ok, baseDeltaPaths: [p] }).decision, "full_regate", p);
  }
});

test("validator: rejects forged records and head mismatch", () => {
  const partial = classifyBaseMergeCarry({ ...ok, baseDeltaPaths: ["src/x.mjs"] });
  assert.equal(validateBaseMergeCarryEvidence(partial).ok, true);
  // decision flipped to carry_verdict with the intersection emptied
  assert.equal(validateBaseMergeCarryEvidence({ ...partial, decision: "carry_verdict", pathIntersection: [] }).ok, false);
  const ev = classifyBaseMergeCarry(ok);
  assert.equal(validateBaseMergeCarryEvidence(ev, { expectedSourceHead: A, expectedNewHead: B }).ok, true);
  assert.equal(validateBaseMergeCarryEvidence(ev, { expectedNewHead: A }).ok, false);
  assert.equal(validateBaseMergeCarryEvidence(ev, { expectedSourceHead: B }).ok, false);
  assert.equal(validateBaseMergeCarryEvidence({ ...partial, patchIdAfter: "p2" }).ok, false);
});

test("gate tooling matcher rejects look-alike non-tooling paths", () => {
  for (const p of ["src/app.js", "docs/guide.md", "test/foo.test.mjs", "extension.md"]) {
    assert.equal(classifyBaseMergeCarry({ ...ok, baseDeltaPaths: [p] }).decision, "carry_verdict", p);
  }
});

test("git: hand-resolved conflict merge forces full re-gate", async () => {
  const s = setup();
  s.put("base.txt", `PR\n${LINES.slice(6)}`); s.git("add", "-A"); s.git("commit", "-qm", "pr edits line0");
  const prev = s.head();
  s.git("checkout", "-q", "main"); s.put("base.txt", `MAIN\n${LINES.slice(6)}`); s.git("add", "-A"); s.git("commit", "-qm", "main edits line0");
  s.git("checkout", "-q", "pr");
  try { s.git("merge", "--no-edit", "main"); } catch { /* conflict expected */ }
  s.put("base.txt", `PR\nMAIN\n${LINES.slice(6)}`); s.git("add", "-A"); s.git("commit", "-qm", "resolve");
  const ev = await computeBaseMergeCarry({ prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir });
  assert.equal(ev.conflictResolutionHunks, true);
  assert.equal(ev.decision, "full_regate");
});

test("git: clean base merge after a resolved conflict merge still forces full re-gate", async () => {
  const s = setup();
  s.put("base.txt", `PR\n${LINES.slice(6)}`); s.git("add", "-A"); s.git("commit", "-qm", "pr edits line0");
  const prev = s.head();
  s.git("checkout", "-q", "main"); s.put("base.txt", `MAIN\n${LINES.slice(6)}`); s.git("add", "-A"); s.git("commit", "-qm", "main edits line0");
  s.git("checkout", "-q", "pr");
  try { s.git("merge", "--no-edit", "main"); } catch { /* conflict expected */ }
  s.put("base.txt", `PR\nMAIN\n${LINES.slice(6)}`); s.git("add", "-A"); s.git("commit", "-qm", "resolve");
  s.git("checkout", "-q", "main"); s.put("docs/other.md", "changed\n"); s.git("add", "-A"); s.git("commit", "-qm", "clean main move");
  s.git("checkout", "-q", "pr"); s.git("merge", "-q", "--no-edit", "main");
  const ev = await computeBaseMergeCarry({ prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir });
  assert.equal(ev.conflictResolutionHunks, true);
  assert.equal(ev.decision, "full_regate");
});

test("main: writes the keyed evidence artifact and refuses a short prev-head", async () => {
  const s = setup();
  const prev = s.head();
  s.git("checkout", "-q", "main"); s.put("docs/other.md", "changed\n"); s.git("add", "-A"); s.git("commit", "-qm", "main move");
  s.git("checkout", "-q", "pr"); s.git("merge", "-q", "--no-edit", "main");
  const head = s.head();
  const tmpRoot = path.join(s.dir, "out");
  const args = ["--repo", "o/r", "--pr", "1", "--gate", "draft_gate", "--prev-head", prev, "--head-sha", head, "--base-ref", "main", "--tmp-root", tmpRoot];
  const saved = process.exitCode;
  const written = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { written.push(String(c)); return true; };
  try {
    await main(args, { repoRoot: s.dir });
  } finally { process.stdout.write = realWrite; }
  assert.equal(process.exitCode ?? 0, 0);
  const out = JSON.parse(written.join(""));
  assert.equal(out.decision, "carry_verdict");
  assert.equal(out.path, path.resolve(s.dir, buildBaseMergeCarryPath({ repo: "o/r", pr: "1", gate: "draft_gate", headSha: head, tmpRoot })));
  const durable = JSON.parse(readFileSync(out.path, "utf8"));
  assert.equal(durable.decision, out.decision);
  assert.equal(durable.sourceHead, prev);
  assert.equal(durable.newHead, head);
  const errs = [];
  const realErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (c) => { errs.push(String(c)); return true; };
  try {
    await main(args.map((a) => (a === prev ? prev.slice(0, 7) : a)), { repoRoot: s.dir });
  } finally { process.stderr.write = realErr; }
  assert.equal(process.exitCode, 1);
  process.exitCode = saved;
});

test("git: patch ids ignore repo-local core.abbrev and diff.suppressBlankEmpty", async () => {
  const s = setup();
  s.put("blank.txt", "a\n\nb\n"); s.put("bin.dat", Buffer.from([0, 1, 2, 3]));
  s.git("add", "-A"); s.git("commit", "-qm", "files");
  const prev = s.head();
  s.put("blank.txt", "a\n\nc\n"); s.put("bin.dat", Buffer.from([0, 9, 2, 3]));
  s.git("add", "-A"); s.git("commit", "-qm", "edit");
  const args = { prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir };
  const plain = await computeBaseMergeCarry(args);
  s.git("config", "core.abbrev", "12"); s.git("config", "diff.suppressBlankEmpty", "true");
  const configured = await computeBaseMergeCarry(args);
  assert.ok(plain.patchIdAfter);
  assert.equal(configured.patchIdAfter, plain.patchIdAfter);
});
