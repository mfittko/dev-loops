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
function advance(s, file, extra = {}) {
  const prev = s.head();
  s.git("checkout", "-q", "main");
  s.put(file, "changed\n");
  s.git("add", "-A"); s.git("commit", "-qm", "main move");
  s.git("checkout", "-q", "pr");
  s.git("merge", "-q", "--no-edit", "main");
  return computeBaseMergeCarry({ prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir, ...extra });
}

// Issue 2752 slice 4: the fixer-emit seam option skips only the gate-tooling decision and its evidence never validates under the default rule.
test("ignoreGateTooling: skips only the tooling decision; conflicts, changed blobs and overlaps still refuse", () => {
  const opt = { ignoreGateTooling: true };
  const tooling = { ...ok, baseDeltaPaths: ["scripts/github/write-gate-context.mjs"] };
  assert.equal(classifyBaseMergeCarry(tooling).decision, "full_regate");
  assert.equal(classifyBaseMergeCarry(tooling, opt).decision, "carry_verdict");
  assert.equal(classifyBaseMergeCarry({ ...tooling, conflictResolutionHunks: true }, opt).decision, "full_regate");
  assert.equal(classifyBaseMergeCarry({ ...tooling, prBlobsAfter: [`src/x.mjs\t100644\t${"2".repeat(40)}`] }, opt).decision, "full_regate");
  assert.equal(classifyBaseMergeCarry({ ...tooling, baseDeltaPaths: ["scripts/github/write-gate-context.mjs", "src/x.mjs"] }, opt).decision, "full_regate");
});

test("ignoreGateTooling: seam evidence validates only with the option, even when no tooling path is in the delta", () => {
  const opt = { ignoreGateTooling: true };
  for (const input of [{ ...ok, baseDeltaPaths: ["scripts/github/write-gate-context.mjs"] }, ok]) {
    const seam = classifyBaseMergeCarry(input, opt);
    assert.equal(seam.decision, "carry_verdict");
    assert.equal(validateBaseMergeCarryEvidence(seam, opt).ok, true);
    assert.equal(validateBaseMergeCarryEvidence(seam).ok, false);
  }
  const genuine = classifyBaseMergeCarry(ok);
  assert.equal(validateBaseMergeCarryEvidence(genuine).ok, true);
});

test("git: ignoreGateTooling carries a .devloops base move that the default rule re-gates", async () => {
  const ev = await advance(setup(), ".devloops", { ignoreGateTooling: true });
  assert.equal(ev.decision, "carry_verdict", ev.reason);
  assert.deepEqual(ev.gateToolingPaths, [".devloops"]);
  assert.equal((await advance(setup(), ".devloops")).decision, "full_regate");
});

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

test("git: distant base edit in a PR file partial-carries that file only", async () => {
  const s = setup();
  s.put("base.txt", `PR\n${LINES.slice(6)}`); s.git("add", "-A"); s.git("commit", "-qm", "pr edits top of base.txt");
  const prev = s.head();
  s.git("checkout", "-q", "main"); s.put("base.txt", `${LINES.slice(0, -7)}MAIN\n`); s.git("add", "-A"); s.git("commit", "-qm", "main edits bottom");
  s.git("checkout", "-q", "pr");
  // distant hunks merge cleanly; the base delta still touches a PR path
  s.git("merge", "-q", "--no-edit", "main");
  const ev = await computeBaseMergeCarry({ prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir });
  assert.equal(ev.decision, "partial_carry", ev.reason);
  assert.deepEqual(ev.rerunPaths, ["base.txt"]);
  assert.equal(validateBaseMergeCarryEvidence(ev).ok, true);
});

test("git: base edit above the PR hunk (same file, line shift) partial-carries", async () => {
  const s = setup();
  s.put("base.txt", `${LINES.slice(0, -7)}PR\n`); s.git("add", "-A"); s.git("commit", "-qm", "pr edits bottom of base.txt");
  const prev = s.head();
  s.git("checkout", "-q", "main"); s.put("base.txt", `TOP1\nTOP2\n${LINES}`); s.git("add", "-A"); s.git("commit", "-qm", "main inserts at top");
  s.git("checkout", "-q", "pr"); s.git("merge", "-q", "--no-edit", "main");
  const ev = await computeBaseMergeCarry({ prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir });
  assert.equal(ev.decision, "partial_carry", ev.reason);
  assert.deepEqual(ev.pathIntersection, ["base.txt"]);
  assert.deepEqual(ev.rerunPaths, ["base.txt"]);
  assert.equal(ev.prHunkDigests["base.txt"].before, ev.prHunkDigests["base.txt"].after);
  assert.equal(validateBaseMergeCarryEvidence(ev).ok, true);
  assert.equal(validateBaseMergeCarryEvidence({ ...ev, decision: "carry_verdict" }).ok, false);
});

test("git: a PR hunk edit plus a clean same-file base merge is a full re-gate with unequal hunk digests", async () => {
  const s = setup();
  s.put("base.txt", `${LINES.slice(0, -7)}PR\n`); s.git("add", "-A"); s.git("commit", "-qm", "pr edits bottom of base.txt");
  const prev = s.head();
  s.put("base.txt", `${LINES.slice(0, -7)}PR2\n`); s.git("add", "-A"); s.git("commit", "-qm", "pr edits its own hunk again");
  s.git("checkout", "-q", "main"); s.put("base.txt", `TOP1\nTOP2\n${LINES}`); s.git("add", "-A"); s.git("commit", "-qm", "main inserts at top");
  s.git("checkout", "-q", "pr"); s.git("merge", "-q", "--no-edit", "main");
  const ev = await computeBaseMergeCarry({ prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir });
  assert.equal(ev.decision, "full_regate", ev.reason);
  assert.equal(typeof ev.prHunkDigests["base.txt"].before, "string");
  assert.equal(typeof ev.prHunkDigests["base.txt"].after, "string");
  assert.notEqual(ev.prHunkDigests["base.txt"].before, ev.prHunkDigests["base.txt"].after);
});

test("git: conflicting base edit inside the PR hunk runs the resolution delta", async () => {
  const s = setup();
  s.put("base.txt", `${LINES.slice(0, -7)}PR\n`); s.git("add", "-A"); s.git("commit", "-qm", "pr edits bottom");
  const prev = s.head();
  s.git("checkout", "-q", "main"); s.put("base.txt", `${LINES.slice(0, -7)}MAIN\n`); s.git("add", "-A"); s.git("commit", "-qm", "main edits same lines");
  s.git("checkout", "-q", "pr");
  try { s.git("merge", "--no-edit", "main"); } catch { /* conflict expected */ }
  s.put("base.txt", `${LINES.slice(0, -7)}PR\nMAIN\n`); s.git("add", "-A"); s.git("commit", "-qm", "resolve");
  const ev = await computeBaseMergeCarry({ prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir });
  assert.equal(ev.decision, "resolution_delta", ev.reason);
  assert.deepEqual(ev.resolutionPaths, ["base.txt"]);
  assert.deepEqual(ev.resolutionMerges, [s.head()]);
  assert.deepEqual(ev.rerunPaths, ["base.txt"]);
  assert.equal(validateBaseMergeCarryEvidence(ev).ok, true);
  assert.equal(validateBaseMergeCarryEvidence({ ...ev, resolutionMerges: ["nope"] }).ok, false);
});

const X_AFTER = [`src/x.mjs\t100644\t${"2".repeat(40)}`];
const XD = (before, after) => ({ "src/x.mjs": { before, after } });

test("pure: null or malformed resolutionPaths and prHunkDigests fall back without throwing", () => {
  const base = { ...ok, prBlobsAfter: X_AFTER, baseDeltaPaths: ["src/x.mjs"], prHunkDigests: XD("h", "h") };
  assert.equal(classifyBaseMergeCarry(base).decision, "partial_carry");
  for (const good of [[], ["a.txt"]]) assert.notEqual(classifyBaseMergeCarry({ ...base, resolutionPaths: good }).decision, "fallback_full", JSON.stringify(good));
  for (const bad of [null, "a.txt", {}]) {
    assert.equal(classifyBaseMergeCarry({ ...base, resolutionPaths: bad }).decision, "fallback_full", `resolutionPaths=${JSON.stringify(bad)}`);
  }
  assert.equal(classifyBaseMergeCarry({ ...base, prHunkDigests: null }).decision, "fallback_full");
});

test("validator: a shrunk rerunPaths, malformed or null resolutionPaths and edited prHunkDigests are refused", () => {
  const ev = classifyBaseMergeCarry({ ...ok, prBlobsAfter: X_AFTER, baseDeltaPaths: ["src/x.mjs"], prHunkDigests: XD("h", "h") });
  assert.equal(ev.decision, "partial_carry");
  assert.equal(validateBaseMergeCarryEvidence(ev).ok, true);
  assert.equal(validateBaseMergeCarryEvidence({ ...ev, rerunPaths: [] }).ok, false);
  assert.equal(validateBaseMergeCarryEvidence({ ...ev, resolutionPaths: "a.txt" }).ok, false);
  assert.equal(validateBaseMergeCarryEvidence({ ...ev, resolutionPaths: null }).ok, false);
  assert.equal(validateBaseMergeCarryEvidence({ ...ev, prHunkDigests: XD("h", "g") }).ok, false);
  assert.equal(validateBaseMergeCarryEvidence({ ...ev, prHunkDigests: XD(null, null) }).ok, false);
});

test("pure: a file named __proto__ keeps its digest through a JSON round trip; an inherited key is never a digest", () => {
  const blobs = (oid) => [`__proto__\t100644\t${oid.repeat(40)}`];
  const prHunkDigests = JSON.parse('{"__proto__":{"before":"h","after":"h"}}');
  const input = { ...ok, prBlobsBefore: blobs("1"), prBlobsAfter: blobs("2"), baseDeltaPaths: ["__proto__"], prHunkDigests };
  const ev = classifyBaseMergeCarry(input);
  assert.equal(ev.decision, "partial_carry", ev.reason);
  const round = JSON.parse(JSON.stringify(ev));
  assert.equal(validateBaseMergeCarryEvidence(round).ok, true);
  const inherited = { ...ok, prBlobsBefore: [`constructor\t100644\t${"1".repeat(40)}`], prBlobsAfter: [`constructor\t100644\t${"2".repeat(40)}`], baseDeltaPaths: ["constructor"], prHunkDigests: {} };
  assert.equal(classifyBaseMergeCarry(inherited).decision, "full_regate");
});

test("pure: a conflict merge with a null-digest changed path is a full re-gate", () => {
  const base = { ...ok, prBlobsAfter: X_AFTER, baseDeltaPaths: ["src/x.mjs"], conflictResolutionHunks: true, resolutionPaths: ["src/r.mjs"] };
  assert.equal(classifyBaseMergeCarry({ ...base, prHunkDigests: XD("h", "h") }).decision, "resolution_delta");
  assert.equal(classifyBaseMergeCarry({ ...base, prHunkDigests: XD(null, null) }).decision, "full_regate");
  assert.equal(classifyBaseMergeCarry({ ...base, prHunkDigests: XD("h", null) }).decision, "full_regate");
  assert.equal(classifyBaseMergeCarry({ ...base }).decision, "full_regate");
});

test("pure: a base-overlapped path with an unchanged blob joins rerunPaths in both branches", () => {
  const prBlobsBefore = [blob, `src/k.mjs\t100644\t${"5".repeat(40)}`];
  const prBlobsAfter = [...X_AFTER, `src/k.mjs\t100644\t${"5".repeat(40)}`];
  const base = { ...ok, prBlobsBefore, prBlobsAfter, baseDeltaPaths: ["src/x.mjs", "src/k.mjs"], prHunkDigests: XD("h", "h") };
  const partial = classifyBaseMergeCarry(base);
  assert.equal(partial.decision, "partial_carry");
  assert.deepEqual(partial.rerunPaths, ["src/k.mjs", "src/x.mjs"]);
  assert.equal(validateBaseMergeCarryEvidence(partial).ok, true);
  assert.equal(validateBaseMergeCarryEvidence({ ...partial, rerunPaths: ["src/x.mjs"] }).ok, false);
  const res = classifyBaseMergeCarry({ ...base, conflictResolutionHunks: true, resolutionPaths: ["src/r.mjs"] });
  assert.deepEqual(res.rerunPaths, ["src/k.mjs", "src/r.mjs", "src/x.mjs"]);
});

test("git: a merge that keeps the PR side of an overlapped file next to a shifted file reruns both", async () => {
  const s = setup();
  s.git("checkout", "-q", "main"); s.put("b.txt", LINES); s.git("add", "-A"); s.git("commit", "-qm", "main adds b");
  s.git("checkout", "-q", "pr"); s.git("merge", "-q", "--no-edit", "main");
  s.put("base.txt", `${LINES.slice(0, -7)}PR\n`); s.put("b.txt", `${LINES.slice(0, -7)}PR\n`); s.git("add", "-A"); s.git("commit", "-qm", "pr edits base and b");
  const prev = s.head();
  s.git("checkout", "-q", "main"); s.put("base.txt", `TOP\n${LINES}`); s.put("b.txt", `${LINES.slice(0, -7)}MAIN\n`); s.git("add", "-A"); s.git("commit", "-qm", "main edits base and b");
  s.git("checkout", "-q", "pr");
  try { s.git("merge", "--no-edit", "-X", "ours", "main"); } catch { /* -X ours resolves the conflict */ }
  const ev = await computeBaseMergeCarry({ prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir });
  assert.equal(ev.decision, "partial_carry", ev.reason);
  assert.deepEqual(ev.rerunPaths, ["b.txt", "base.txt"]);
  assert.equal(validateBaseMergeCarryEvidence(ev).ok, true);
});

test("git: a binary PR file under a same-file base edit, including a conflict merge, is a full re-gate", async () => {
  const s = setup();
  s.put("bin.dat", Buffer.from([0, 1, 2, 3])); s.put("base.txt", `${LINES.slice(0, -7)}PR\n`); s.git("add", "-A"); s.git("commit", "-qm", "pr adds binary and edits bottom");
  const prev = s.head();
  s.git("checkout", "-q", "main"); s.put("bin.dat", Buffer.from([0, 7, 2, 3])); s.put("base.txt", `${LINES.slice(0, -7)}MAIN\n`); s.git("add", "-A"); s.git("commit", "-qm", "main edits both");
  s.git("checkout", "-q", "pr");
  try { s.git("merge", "--no-edit", "main"); } catch { /* conflict expected */ }
  s.put("bin.dat", Buffer.from([0, 5, 2, 3])); s.put("base.txt", `${LINES.slice(0, -7)}PR\nMAIN\n`); s.git("add", "-A"); s.git("commit", "-qm", "resolve");
  const ev = await computeBaseMergeCarry({ prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir });
  assert.equal(ev.conflictResolutionHunks, true);
  assert.equal(ev.decision, "full_regate", ev.reason);
});

test("pure: partial carry needs equal digests, a base touch and no tooling; a null digest re-gates", () => {
  const prBlobsAfter = [`src/x.mjs\t100644\t${"2".repeat(40)}`];
  const base = { ...ok, prBlobsAfter, baseDeltaPaths: ["src/x.mjs"] };
  const d = (before, after) => ({ "src/x.mjs": { before, after } });
  assert.equal(classifyBaseMergeCarry({ ...base, prHunkDigests: d("h", "h") }).decision, "partial_carry");
  assert.equal(classifyBaseMergeCarry({ ...base, prHunkDigests: d("h", "g") }).decision, "full_regate");
  assert.equal(classifyBaseMergeCarry({ ...base, prHunkDigests: d(null, null) }).decision, "full_regate");
  assert.equal(classifyBaseMergeCarry({ ...base }).decision, "full_regate");
  assert.equal(classifyBaseMergeCarry({ ...base, baseDeltaPaths: ["docs/y.md"], prHunkDigests: d("h", "h") }).decision, "full_regate");
  assert.equal(classifyBaseMergeCarry({ ...base, baseDeltaPaths: ["src/x.mjs", ".devloops"], prHunkDigests: d("h", "h") }).decision, "full_regate");
});

test("pure: carry_verdict evidence keeps the pre-3284 key set, and resolution reruns include shifted files", () => {
  const ev = classifyBaseMergeCarry(ok);
  assert.deepEqual(Object.keys(ev), ["sourceHead", "newHead", "prBlobsBefore", "prBlobsAfter", "prDiffPaths", "baseDeltaPaths", "conflictResolutionHunks", "pathIntersection", "gateToolingPaths", "decision", "reason"]);
  const prBlobsAfter = [`src/x.mjs\t100644\t${"2".repeat(40)}`, `src/z.mjs\t100644\t${"3".repeat(40)}`];
  const prBlobsBefore = [blob, `src/z.mjs\t100644\t${"4".repeat(40)}`];
  const res = classifyBaseMergeCarry({
    ...ok, prBlobsBefore, prBlobsAfter, baseDeltaPaths: ["src/x.mjs"], conflictResolutionHunks: true, resolutionPaths: ["src/r.mjs"],
    prHunkDigests: { "src/x.mjs": { before: "h", after: "h" }, "src/z.mjs": { before: "h", after: "g" } },
  });
  assert.equal(res.decision, "resolution_delta");
  assert.deepEqual(res.rerunPaths, ["src/r.mjs", "src/x.mjs", "src/z.mjs"]);
  assert.equal(validateBaseMergeCarryEvidence(res).ok, true);
});

test("git: a non-ASCII changed path has no sound digest and re-gates", async () => {
  const s = setup();
  s.git("checkout", "-q", "main"); s.put("ü.txt", LINES); s.git("add", "-A"); s.git("commit", "-qm", "main adds file");
  s.git("checkout", "-q", "pr"); s.git("merge", "-q", "--no-edit", "main");
  s.put("ü.txt", `${LINES.slice(0, -7)}PR\n`); s.git("add", "-A"); s.git("commit", "-qm", "pr edits bottom");
  const prev = s.head();
  s.git("checkout", "-q", "main"); s.put("ü.txt", `TOP\n${LINES}`); s.git("add", "-A"); s.git("commit", "-qm", "main inserts at top");
  s.git("checkout", "-q", "pr"); s.git("merge", "-q", "--no-edit", "main");
  const ev = await computeBaseMergeCarry({ prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir });
  assert.equal(ev.decision, "full_regate", ev.reason);
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

// ADR 0296: only paths that can change a gate outcome re-gate.
const OUTCOME_PATHS = [
  "agents/review.agent.md", "agents/judge.agent.md", "agents/gate-coordinator.agent.md", ".claude/agents/judge.md",
  "skills/docs/gate-review-sub-loop-contract.md", ".claude/skills/docs/judge-contract.md", "skills/docs/pre-pr-review-contract.md",
  "scripts/github/write-gate-context.mjs", "scripts/loop/consolidate-fanin.mjs", "scripts/loop/check-judge-decision.mjs",
  "scripts/github/_carried-verdict.mjs", "packages/core/src/loop/base-merge-verdict-carry.mjs",
  ".devloops", "package.json", "packages/core/package.json",
  "scripts/gate-x.mjs", "scripts/loop/x/gate-check.mjs", "scripts/github/build-adjacent-bundle.mjs",
  "skills/docs/validation-policy.md", "skills/docs/spec-authority-contract.md", "skills/local-implementation/SKILL.md",
  ".claude/skills/docs/validation-policy.md", ".claude/skills/docs/spec-authority-contract.md", "agents/docs.agent.md", ".claude/agents/docs.md",
  "packages/core/src/config/config.mjs", "packages/core/src/loop/spec-authority.mjs", "packages/core/src/analysis/diff-analyzer.mjs", "packages/core/src/analysis/change-classifier.mjs", "skills/docs/copilot-loop-operations.md", ".claude/skills/docs/copilot-loop-operations.md", "skills/docs/contract-style-guide.md", ".claude/skills/docs/contract-style-guide.md", "scripts/github/_findings-x.mjs", "skills/docs/acceptance-criteria-verification.md", ".claude/skills/docs/structural-quality.md",
];
const NON_OUTCOME_PATHS = [
  "package-lock.json", "bun.lock", "pnpm-lock.yaml", "scripts/github/edit-pr.mjs", "test/helpers/x.mjs", "agents/developer.agent.md",
  "scripts/_core-helpers.mjs", "scripts/github/navigate.mjs", "scripts/loop/x/preview.mjs", "scripts/github/comment-issue.mjs", "skills/docs/release-runbook.md",
  "skills/docs/worktree-guidance.md", ".claude/skills/docs/worktree-guidance.md", "skills/docs/main-agent-contract.md", "skills/docs/anti-patterns.md", "skills/docs/contract-style-guide-notes.md", "skills/docs/copilot-loop-operations-notes.md", "packages/core/src/loop/normalize.mjs", "packages/core/src/loop/spec-authority-notes.mjs", "packages/core/src/foo/bar.mjs", "packages/core/src/analysis/diff-analyzer-notes.mjs", "packages/core/src/analysis/other-helper.mjs", "schemas/a.json",
  "extension/readonly-role-gate.ts", "commands/loop-review.command.md", "AGENTS.md", "bunfig.toml", ".github/workflows/ci.yml",
];

test("gate tooling: outcome-relevant paths re-gate, other tooling paths carry, validator agrees", () => {
  for (const p of OUTCOME_PATHS) {
    const ev = classifyBaseMergeCarry({ ...ok, baseDeltaPaths: [p] });
    assert.equal(ev.decision, "full_regate", p);
    assert.equal(validateBaseMergeCarryEvidence(ev).ok, true, p);
    assert.equal(validateBaseMergeCarryEvidence({ ...ev, decision: "carry_verdict" }).ok, false, p);
  }
  for (const p of NON_OUTCOME_PATHS) {
    const ev = classifyBaseMergeCarry({ ...ok, baseDeltaPaths: [p] });
    assert.equal(ev.decision, "carry_verdict", p);
    assert.deepEqual(ev.gateToolingPaths, [], p);
    assert.equal(validateBaseMergeCarryEvidence(ev).ok, true, p);
  }
});

test("git: a lockfile, test helper or unrelated script base move carries; a gate script or judge agent move re-gates", async () => {
  for (const p of ["package-lock.json", "test/helpers/x.mjs", "scripts/github/edit-pr.mjs"]) {
    assert.equal((await advance(setup(), p)).decision, "carry_verdict", p);
  }
  for (const p of ["agents/judge.agent.md", "skills/docs/gate-review-sub-loop-contract.md", "scripts/github/write-gate-context.mjs", "package.json", "packages/core/src/config/config.mjs"]) {
    assert.equal((await advance(setup(), p)).decision, "full_regate", p);
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

test("git: hand-resolved conflict merge runs a resolution delta", async () => {
  const s = setup();
  s.put("base.txt", `PR\n${LINES.slice(6)}`); s.git("add", "-A"); s.git("commit", "-qm", "pr edits line0");
  const prev = s.head();
  s.git("checkout", "-q", "main"); s.put("base.txt", `MAIN\n${LINES.slice(6)}`); s.git("add", "-A"); s.git("commit", "-qm", "main edits line0");
  s.git("checkout", "-q", "pr");
  try { s.git("merge", "--no-edit", "main"); } catch { /* conflict expected */ }
  s.put("base.txt", `PR\nMAIN\n${LINES.slice(6)}`); s.git("add", "-A"); s.git("commit", "-qm", "resolve");
  const ev = await computeBaseMergeCarry({ prevHead: prev, headSha: s.head(), baseRef: "main", repoRoot: s.dir });
  assert.equal(ev.conflictResolutionHunks, true);
  assert.equal(ev.decision, "resolution_delta");
});

test("git: clean base merge after a resolved conflict merge still runs the resolution delta", async () => {
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
  assert.equal(ev.decision, "resolution_delta");
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
