import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { classifyBaseMergeCarry, validateBaseMergeCarryEvidence } from "@dev-loops/core/loop/base-merge-verdict-carry";
import { buildBaseMergeCarryPath, computeBaseMergeCarry, main, runPinnedGit } from "../../scripts/github/classify-base-merge-carry.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const blob = `src/x.mjs\t100644\t${"1".repeat(40)}`;
const ok = { sourceHead: A, newHead: B, prBlobsBefore: [blob], prBlobsAfter: [blob], baseDeltaPaths: ["docs/y.md"] };

test("pure: carry, full, fallback", () => {
  assert.equal(classifyBaseMergeCarry(ok).decision, "carry_verdict");
  assert.equal(classifyBaseMergeCarry({ ...ok, baseDeltaPaths: ["src/x.mjs"] }).decision, "full_regate");
  assert.equal(classifyBaseMergeCarry({ ...ok, baseDeltaPaths: [".devloops"] }).decision, "full_regate");
  assert.equal(classifyBaseMergeCarry({ ...ok, baseDeltaPaths: ["skills/docs/gate-review-sub-loop-contract.md"] }).decision, "full_regate");
  assert.equal(classifyBaseMergeCarry({ ...ok, prBlobsAfter: [`src/x.mjs\t100644\t${"2".repeat(40)}`] }).decision, "full_regate");
  assert.equal(classifyBaseMergeCarry({ ...ok, prBlobsAfter: [`src/x.mjs\t100755\t${"1".repeat(40)}`] }).decision, "full_regate");
  assert.equal(classifyBaseMergeCarry({ ...ok, conflictResolutionHunks: true }).decision, "full_regate");
  assert.equal(classifyBaseMergeCarry({ ...ok, detectionError: "boom" }).decision, "fallback_full");
  assert.equal(classifyBaseMergeCarry({ ...ok, prBlobsBefore: [] }).decision, "fallback_full");
  assert.equal(classifyBaseMergeCarry({ ...ok, newHead: A }).decision, "fallback_full");
});

test("pure: non-string or empty evidence values never carry", () => {
  for (const bad of [1, true, "", [1], [""], [true], "x"]) {
    for (const field of ["prBlobsBefore", "prBlobsAfter"]) {
      assert.equal(classifyBaseMergeCarry({ ...ok, [field]: bad }).decision, "fallback_full", `${field}=${JSON.stringify(bad)}`);
    }
  }
  const forged = { ...classifyBaseMergeCarry(ok), prBlobsBefore: [1], prBlobsAfter: [1] };
  assert.equal(validateBaseMergeCarryEvidence(forged).ok, false);
});

test("validator: accepts genuine evidence and rejects tampering", () => {
  const ev = classifyBaseMergeCarry(ok);
  assert.equal(validateBaseMergeCarryEvidence(ev).ok, true);
  assert.equal(validateBaseMergeCarryEvidence({ ...ev, prBlobsAfter: [`src/x.mjs\t100644\t${"2".repeat(40)}`] }).ok, false);
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
  assert.deepEqual(ev.prBlobsBefore, ev.prBlobsAfter);
});

test("git: .devloops base move forces full re-gate", async () => {
  const ev = await advance(setup(), ".devloops");
  assert.equal(ev.decision, "full_regate");
  assert.deepEqual(ev.gateToolingPaths, [".devloops"]);
});

test("git: base move touching a PR path forces full re-gate", async () => {
  const s = setup();
  s.put("base.txt", `PR\n${LINES.slice(6)}`); s.git("add", "-A"); s.git("commit", "-qm", "pr edits top of base.txt");
  const prev = s.head();
  s.git("checkout", "-q", "main"); s.put("base.txt", `${LINES.slice(0, -7)}MAIN\n`); s.git("add", "-A"); s.git("commit", "-qm", "main edits bottom");
  s.git("checkout", "-q", "pr");
  // distant hunks merge cleanly; the base delta still touches a PR path
  s.git("merge", "-q", "--no-edit", "main");
  const ev = await computeBaseMergeCarry({ prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir });
  assert.equal(ev.decision, "full_regate", ev.reason);
});

test("git: base edit above the PR hunk (same file, line shift) forces full re-gate", async () => {
  const s = setup();
  s.put("base.txt", `${LINES.slice(0, -7)}PR\n`); s.git("add", "-A"); s.git("commit", "-qm", "pr edits bottom of base.txt");
  const prev = s.head();
  s.git("checkout", "-q", "main"); s.put("base.txt", `TOP1\nTOP2\n${LINES}`); s.git("add", "-A"); s.git("commit", "-qm", "main inserts at top");
  s.git("checkout", "-q", "pr"); s.git("merge", "-q", "--no-edit", "main");
  const ev = await computeBaseMergeCarry({ prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir });
  assert.equal(ev.decision, "full_regate", ev.reason);
  assert.deepEqual(ev.pathIntersection, ["base.txt"]);
});

test("git: hostile ambient env and repo-local config never change the evidence", async () => {
  const s = setup();
  s.put("dä/blank.txt", "a\n\nb\n\nc\n"); s.git("add", "-A"); s.git("commit", "-qm", "blank file");
  s.put("base.txt", `PR\n${LINES.slice(6)}`); s.put("dä/blank.txt", "a\n\nB\n\nc\n"); s.git("add", "-A"); s.git("commit", "-qm", "pr edits");
  const prev = s.head();
  s.git("checkout", "-q", "main"); s.put("base.txt", `${LINES.slice(0, -7)}MAIN\n`); s.git("add", "-A"); s.git("commit", "-qm", "main edits bottom");
  s.git("checkout", "-q", "pr"); s.git("merge", "-q", "--no-edit", "main");
  s.git("checkout", "-qb", "attrs"); s.put(".gitattributes", "* -diff\n"); s.git("add", "-A"); s.git("commit", "-qm", "attrs");
  s.git("checkout", "-q", "pr");
  const cfg = path.join(s.dir, "..", `${path.basename(s.dir)}.gitconfig`);
  const hostile = "[core]\n\tabbrev = 7\n[diff]\n\tsuppressBlankEmpty = true\n\talgorithm = histogram\n\tinterHunkContext = 10\n[color]\n\tui = always\n";
  writeFileSync(cfg, hostile);
  const home = mkdtempSync(path.join(os.tmpdir(), "bmc-home-"));
  mkdirSync(path.join(home, "git"));
  writeFileSync(path.join(home, ".gitconfig"), hostile);
  writeFileSync(path.join(home, "git", "config"), hostile);
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), "bmc-else-"));
  const args = { prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir };
  const clean = await computeBaseMergeCarry(args);
  assert.ok(clean.prBlobsAfter.length > 0);
  const envRows = [
    { GIT_DIFF_OPTS: "--unified=0" }, { GIT_EXTERNAL_DIFF: "false" }, { GIT_ATTR_SOURCE: "attrs" },
    { GIT_CONFIG_PARAMETERS: "'diff.noprefix=true'" }, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "diff.noprefix", GIT_CONFIG_VALUE_0: "true" },
    { GIT_CONFIG_GLOBAL: cfg }, { HOME: home, XDG_CONFIG_HOME: home },
    { GIT_DIR: path.join(elsewhere, ".git"), GIT_WORK_TREE: elsewhere }, { LANG: "de_DE.ISO-8859-1", LC_ALL: "tr_TR.UTF-8" },
  ];
  const localRows = [["diff.noprefix", "true"], ["diff.mnemonicPrefix", "true"], ["core.quotePath", "true"], ["diff.suppressBlankEmpty", "true"], ["core.abbrev", "7"], ["diff.submodule", "log"], ["diff.ignoreSubmodules", "all"]];
  const run = async (env) => {
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try { return await computeBaseMergeCarry(args); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  };
  for (const env of envRows) assert.deepEqual(await run(env), clean, JSON.stringify(env));
  const attrsFile = path.join(home, "attrs");
  writeFileSync(attrsFile, "* -diff\n");
  const fileRows = [
    [".git/info/attributes", () => writeFileSync(path.join(s.dir, ".git", "info", "attributes"), "* -diff\n"), () => rmSync(path.join(s.dir, ".git", "info", "attributes"), { force: true })],
    ["core.attributesFile", () => s.git("config", "core.attributesFile", attrsFile), () => s.git("config", "--unset", "core.attributesFile")],
    ["worktree .gitattributes", () => writeFileSync(path.join(s.dir, ".gitattributes"), "* -diff\n"), () => rmSync(path.join(s.dir, ".gitattributes"), { force: true })],
  ];
  for (const [name, set, unset] of fileRows) {
    set();
    try { assert.deepEqual(await run({}), clean, name); } finally { unset(); }
  }
  for (const [k, v] of localRows) {
    s.git("config", k, v);
    try { assert.deepEqual(await run({}), clean, k); } finally { s.git("config", "--unset", k); }
  }
});

test("git: Latin-1 content change is not masked by utf8 decoding", async () => {
  const s = setup();
  s.put("f.txt", Buffer.from("caf\xE9\n", "latin1")); s.git("add", "-A"); s.git("commit", "-qm", "latin1 e-acute");
  const prev = s.head();
  s.put("f.txt", Buffer.from("caf\xE8\n", "latin1")); s.git("add", "-A"); s.git("commit", "-qm", "latin1 e-grave");
  const ev = await computeBaseMergeCarry({ prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir });
  assert.notDeepEqual(ev.prBlobsBefore, ev.prBlobsAfter);
  assert.equal(ev.decision, "full_regate");
});

test("git: binary NUL content change forces full re-gate", async () => {
  const s = setup();
  s.put("bin.dat", Buffer.from([0, 1, 2, 3])); s.git("add", "-A"); s.git("commit", "-qm", "bin");
  const prev = s.head();
  s.put("bin.dat", Buffer.from([0, 9, 2, 3])); s.git("add", "-A"); s.git("commit", "-qm", "bin edit");
  const ev = await computeBaseMergeCarry({ prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir });
  assert.equal(ev.decision, "full_regate");
});

test("git: submodule commit change forces full re-gate, even with diff.submodule=log", async () => {
  const s = setup();
  const sub = mkdtempSync(path.join(os.tmpdir(), "bmc-sub-"));
  const sg = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: sub, env: ENV, encoding: "utf8" }).trim();
  sg("init", "-q", "-b", "main"); writeFileSync(path.join(sub, "f"), "1\n"); sg("add", "-A"); sg("commit", "-qm", "s1");
  const c1 = sg("rev-parse", "HEAD");
  writeFileSync(path.join(sub, "f"), "2\n"); sg("add", "-A"); sg("commit", "-qm", "s2");
  const c2 = sg("rev-parse", "HEAD");
  // gitlinks via update-index: no submodule checkout or file transport needed
  s.git("update-index", "--add", "--cacheinfo", `160000,${c1},sm`); s.git("commit", "-qm", "gitlink 1");
  const prev = s.head();
  s.git("update-index", "--cacheinfo", `160000,${c2},sm`); s.git("commit", "-qm", "gitlink 2");
  const args = { prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir };
  const plain = await computeBaseMergeCarry(args);
  assert.equal(plain.decision, "full_regate", plain.reason);
  s.git("config", "diff.submodule", "log");
  assert.deepEqual(await computeBaseMergeCarry(args), plain);
});

test("git: a failing diff-tree step falls back to full", async () => {
  const s = setup();
  const runGit = async (args, o) => (args[0] === "diff-tree" ? { code: 1, stdout: Buffer.alloc(0), stderr: "boom" } : runPinnedGit(args, o));
  const prev = s.head();
  s.put("src/y.mjs", "y\n"); s.git("add", "-A"); s.git("commit", "-qm", "more");
  const ev = await computeBaseMergeCarry({ prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir, runGit });
  assert.equal(ev.decision, "fallback_full");
  assert.match(ev.reason, /diff-tree/);
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
  const overlap = classifyBaseMergeCarry({ ...ok, baseDeltaPaths: ["src/x.mjs"] });
  assert.equal(overlap.decision, "full_regate");
  assert.equal(validateBaseMergeCarryEvidence(overlap).ok, true);
  // decision flipped to carry_verdict with the intersection emptied
  assert.equal(validateBaseMergeCarryEvidence({ ...overlap, decision: "carry_verdict", pathIntersection: [] }).ok, false);
  const ev = classifyBaseMergeCarry(ok);
  assert.equal(validateBaseMergeCarryEvidence(ev, { expectedSourceHead: A, expectedNewHead: B }).ok, true);
  assert.equal(validateBaseMergeCarryEvidence(ev, { expectedNewHead: A }).ok, false);
  assert.equal(validateBaseMergeCarryEvidence(ev, { expectedSourceHead: B }).ok, false);
  assert.equal(validateBaseMergeCarryEvidence({ ...ev, prBlobsAfter: [`src/x.mjs\t100644\t${"2".repeat(40)}`] }).ok, false);
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

test("pure: a narrowed prDiffPaths input cannot turn a base-touched PR path into carry", () => {
  const ev = classifyBaseMergeCarry({ ...ok, prDiffPaths: ["unrelated.md"], baseDeltaPaths: ["src/x.mjs"] });
  assert.equal(ev.decision, "full_regate");
  assert.deepEqual(ev.prDiffPaths, ["src/x.mjs"]);
  assert.equal(validateBaseMergeCarryEvidence({ ...classifyBaseMergeCarry(ok), prDiffPaths: [] }).ok, false);
});

test("git: distinct non-UTF-8 PR paths with the same blob never collapse into a carry", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bmc-"));
  const run = (args, input) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, env: ENV, input });
  run(["init", "-q", "-b", "main"]);
  const hash = (c) => run(["hash-object", "-w", "--stdin"], c).toString().trim();
  const [baseOid, x] = [hash("base\n"), hash("x\n")];
  const tree = (...entries) => run(["mktree", "-z"], Buffer.concat(entries.map(([oid, name]) => Buffer.concat([Buffer.from(`100644 blob ${oid}\t`), name, Buffer.from([0])])))).toString().trim();
  const commit = (t, ...parents) => run(["commit-tree", t, ...parents.flatMap((p) => ["-p", p]), "-m", "c"]).toString().trim();
  const baseEntry = [baseOid, Buffer.from("base.txt")];
  const m = commit(tree(baseEntry));
  const a = commit(tree(baseEntry, [x, Buffer.from([0xff])]), m);
  const b = commit(tree(baseEntry, [x, Buffer.from([0xfe])]), a);
  run(["update-ref", "refs/heads/main", m]);
  const ev = await computeBaseMergeCarry({ prevHead: a, headSha: b, baseRef: "main", repoRoot: dir });
  assert.equal(ev.decision, "full_regate", ev.reason);
  rmSync(dir, { recursive: true, force: true });
});

test("git: more than one merge base (criss-cross) falls back to full", async () => {
  const s = setup();
  const runGit = async (args, o) => (args[0] === "merge-base" && args.includes("--all") ? { code: 0, stdout: Buffer.from(`${A}\n${B}\n`), stderr: "" } : runPinnedGit(args, o));
  const prev = s.head();
  s.put("src/y.mjs", "y\n"); s.git("add", "-A"); s.git("commit", "-qm", "more");
  const ev = await computeBaseMergeCarry({ prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir, runGit });
  assert.equal(ev.decision, "fallback_full");
  assert.match(ev.reason, /merge base/);
});
