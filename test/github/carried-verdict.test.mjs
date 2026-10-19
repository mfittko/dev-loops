import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { buildCarriedHeadsPath, carryGateMarker, readCarriedHeads } from "../../scripts/github/_carried-verdict.mjs";
import { buildPreMergeGateCheck } from "../../scripts/github/detect-checkpoint-evidence.mjs";
import { resolveGateArtifactTmpRoot } from "../../scripts/loop/_repo-root-resolver.mjs";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_DIR: undefined, GIT_WORK_TREE: undefined };
const REPO = "owner/repo";
const PR = 2819;
const GATE = "pre_approval_gate";

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "carried-"));
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: dir, env: ENV, encoding: "utf8" }).trim();
  const put = (f, c) => { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), c); };
  git("init", "-q", "-b", "main");
  put("base.txt", "base\n");
  git("add", "-A"); git("commit", "-qm", "base");
  git("checkout", "-qb", "pr");
  put("src/x.mjs", "x\n");
  git("add", "-A"); git("commit", "-qm", "pr");
  const head = () => git("rev-parse", "HEAD");
  const mergeBase = (file) => {
    git("checkout", "-q", "main"); put(file, "changed\n"); git("add", "-A"); git("commit", "-qm", `main ${file}`);
    git("checkout", "-q", "pr"); git("merge", "-q", "--no-edit", "main");
    return head();
  };
  return { dir, git, put, head, mergeBase };
}
const marker = (headSha) => ({ visible: true, verdict: "clean", contractComplete: true, headSha });
const carry = (s, m, currentHeadSha, extra = {}) => carryGateMarker(m, { gate: GATE, repo: REPO, pr: PR, currentHeadSha, baseRef: "main", repoRoot: s.dir, ...extra });
const recordFile = (s, origin) => path.resolve(s.dir, buildCarriedHeadsPath({ repo: REPO, pr: PR, gate: GATE, originHead: origin, tmpRoot: resolveGateArtifactTmpRoot(s.dir) }));

test("record:true carries a base-only merge to the current head and writes the record; record:false then reads it", async () => {
  const s = setup();
  const origin = s.head();
  const cur = s.mergeBase("docs/a.md");
  const carried = await carry(s, marker(origin), cur, { record: true });
  assert.equal(carried.headSha, cur);
  assert.equal(carried.carriedFrom, origin);
  const record = await readCarriedHeads(recordFile(s, origin));
  assert.equal(record.carried[0].headSha, cur);
  assert.equal(record.carried[0].decision, "carry_verdict");
  assert.equal((await carry(s, marker(origin), cur)).carriedFrom, origin, "merge-pr path reads the recorded carry");
});

test("a failing record write returns the uncarried marker and does not throw", async () => {
  const s = setup();
  const origin = s.head();
  const cur = s.mergeBase("docs/a.md");
  const dir = path.dirname(recordFile(s, origin));
  mkdirSync(path.dirname(dir), { recursive: true });
  writeFileSync(dir, "not a directory"); // mkdir of the record dir fails with ENOTDIR
  const m = marker(origin);
  assert.deepEqual(await carry(s, m, cur, { record: true }), m);
});

test("record:false without a record does not carry", async () => {
  const s = setup();
  const origin = s.head();
  const cur = s.mergeBase("docs/a.md");
  const m = marker(origin);
  assert.deepEqual(await carry(s, m, cur), m);
});

test("tampered record evidence and a wrong head do not carry", async () => {
  const s = setup();
  const origin = s.head();
  const cur = s.mergeBase("docs/a.md");
  await carry(s, marker(origin), cur, { record: true });
  const file = recordFile(s, origin);
  const good = readFileSync(file, "utf8");
  const tampered = JSON.parse(good);
  tampered.carried[0].evidence.baseDeltaPaths = ["docs/forged.md"];
  writeFileSync(file, JSON.stringify(tampered));
  assert.equal((await carry(s, marker(origin), cur)).carriedFrom, undefined);
  writeFileSync(file, good);
  const wrong = JSON.parse(good);
  wrong.carried[0].headSha = "c".repeat(40);
  writeFileSync(file, JSON.stringify(wrong));
  assert.equal((await carry(s, marker(origin), cur)).carriedFrom, undefined);
});

test("a non-base commit after the clean verdict (scope change) does not carry", async () => {
  const s = setup();
  const origin = s.head();
  s.put("src/x.mjs", "changed pr blob\n"); s.git("add", "-A"); s.git("commit", "-qm", "pr edit");
  const cur = s.mergeBase("docs/a.md");
  const m = marker(origin);
  assert.deepEqual(await carry(s, m, cur, { record: true }), m);
});

test("two consecutive carried heads are both recorded with classification", async () => {
  const s = setup();
  const origin = s.head();
  const first = s.mergeBase("docs/a.md");
  const second = s.mergeBase("docs/b.md");
  await carry(s, marker(origin), first, { record: true });
  assert.equal((await carry(s, marker(origin), second, { record: true })).carriedFrom, origin);
  const record = await readCarriedHeads(recordFile(s, origin));
  assert.deepEqual(record.carried.map((e) => [e.headSha, e.decision]), [[first, "carry_verdict"], [second, "carry_verdict"]]);
});

test("buildPreMergeGateCheck passes with a carried marker and fails with an uncarried stale-head marker", async () => {
  const s = setup();
  const origin = s.head();
  const cur = s.mergeBase("docs/a.md");
  const evidence = (pre) => ({ currentHeadSha: cur, draftGate: { visible: true, verdict: "clean" }, preApprovalGateMarker: { ...pre, sizeOutcome: "pass", sizeTouchesT1: false } });
  const carried = await carry(s, marker(origin), cur, { record: true });
  assert.equal(buildPreMergeGateCheck(evidence(carried), 0).ok, true);
  assert.equal(buildPreMergeGateCheck(evidence(marker(origin)), 0).ok, false);
});

test("malformed carried entries (null, string, number) fail closed to no carry without throwing; a well-formed entry still carries", async () => {
  const s = setup();
  const origin = s.head();
  const cur = s.mergeBase("docs/a.md");
  await carry(s, marker(origin), cur, { record: true });
  const file = recordFile(s, origin);
  const good = JSON.parse(readFileSync(file, "utf8"));
  for (const bad of [null, "string", 42]) {
    writeFileSync(file, JSON.stringify({ ...good, carried: [bad] }));
    assert.deepEqual((await readCarriedHeads(file)).carried, [], `${JSON.stringify(bad)} entry is dropped`);
    const m = marker(origin);
    assert.deepEqual(await carry(s, m, cur), m, `${JSON.stringify(bad)} entry means no carry`);
    assert.equal((await carry(s, m, cur, { record: true })).carriedFrom, origin, "recording over a malformed entry still carries");
  }
  writeFileSync(file, JSON.stringify({ ...good, carried: [null, ...good.carried] }));
  assert.equal((await carry(s, marker(origin), cur)).carriedFrom, origin, "a well-formed entry beside a malformed one carries");
});

test("re-recording an unchanged carry leaves the record file untouched and leaves no temp files", async () => {
  const s = setup();
  const origin = s.head();
  const cur = s.mergeBase("docs/a.md");
  await carry(s, marker(origin), cur, { record: true });
  const file = recordFile(s, origin);
  writeFileSync(file, `${readFileSync(file, "utf8")}\n`); // sentinel: a rewrite would drop the extra newline
  const before = readFileSync(file, "utf8");
  await carry(s, marker(origin), cur, { record: true });
  assert.equal(readFileSync(file, "utf8"), before);
  assert.deepEqual(readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp-")), []);
});
