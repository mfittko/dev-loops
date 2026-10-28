import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { carryFromPostedVerdict, carryGateMarker, parseCarriedHeads, renderCarriedHeadsBody } from "../../scripts/github/_carried-verdict.mjs";
import { fetchDraftGateEvidence } from "../../scripts/github/_gate-finding-surface.mjs";
import { renderGateReviewCommentBody } from "../../scripts/github/upsert-checkpoint-verdict.mjs";
import { buildPreMergeGateCheck } from "../../scripts/github/detect-checkpoint-evidence.mjs";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_DIR: undefined, GIT_WORK_TREE: undefined };
const REPO = "owner/repo";

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
const GATE = "draft_gate";
// `recorded` is the parsed carried-heads record; `record` (coordination only) appends to `written`.
const carry = (s, m, currentHeadSha, { recorded = [], written = null } = {}) => carryGateMarker(m, {
  gate: GATE, currentHeadSha, baseRef: "main", repoRoot: s.dir, recorded, record: written ? async (e) => { written.push(e); } : null,
});

// Fresh-runner path (#2752 decision 4): setup() builds a bare checkout with no tmp/ state, so
// every case below needs only the posted marker, the posted carried-heads record and git facts.
test("a recorded base-only merge carries from a checkout with no tmp state", async () => {
  const s = setup();
  const origin = s.head();
  const cur = s.mergeBase("docs/a.md");
  const written = [];
  const carried = await carry(s, marker(origin), cur, { written });
  assert.equal(carried.headSha, cur);
  assert.equal(carried.carriedFrom, origin);
  assert.equal((await carry(s, marker(origin), cur, { recorded: written })).carriedFrom, origin);
});

test("a reader never carries a head the coordination path did not record", async () => {
  const s = setup();
  const origin = s.head();
  const cur = s.mergeBase("docs/a.md");
  const m = marker(origin);
  assert.deepEqual(await carry(s, m, cur), m);
});

test("a head with a PR-own change after the clean verdict does not carry", async () => {
  const s = setup();
  const origin = s.head();
  s.put("src/x.mjs", "changed pr blob\n"); s.git("add", "-A"); s.git("commit", "-qm", "pr edit");
  const cur = s.mergeBase("docs/a.md");
  const m = marker(origin);
  const written = [];
  assert.deepEqual(await carry(s, m, cur, { written }), m);
  assert.deepEqual(written, []);
});

// Artifact test: both consecutive carried heads end up in the posted record with their classification.
test("two consecutive base merges are both recorded with their classification and both carry", async () => {
  const s = setup();
  const origin = s.head();
  const first = s.mergeBase("docs/a.md");
  const second = s.mergeBase("docs/b.md");
  const written = [];
  assert.equal((await carry(s, marker(origin), first, { written })).carriedFrom, origin);
  assert.equal((await carry(s, marker(origin), second, { written })).carriedFrom, origin);
  const record = parseCarriedHeads([{ id: 1, body: renderCarriedHeadsBody(written) }]);
  assert.deepEqual(record.map((e) => [e.gate, e.originHead, e.headSha, e.decision]), [
    [GATE, origin, first, "carry_verdict"], [GATE, origin, second, "carry_verdict"],
  ]);
  assert.equal((await carry(s, marker(origin), first, { recorded: record })).carriedFrom, origin);
  assert.equal((await carry(s, marker(origin), second, { recorded: record })).carriedFrom, origin);
});

test("the posted record stays bounded: digest only, pruned to the current origin head, capped", async () => {
  const s = setup();
  const origin = s.head();
  const cur = s.mergeBase("docs/a.md");
  s.git("update-ref", "refs/remotes/origin/main", "main");
  const stored = [];
  const runJson = async (args) => { stored.push(args.find((a) => String(a).startsWith("body="))); return { id: 9 }; };
  const stale = Array.from({ length: 30 }, (_, i) => ({ gate: GATE, originHead: "b".repeat(40), headSha: String(i).padStart(40, "0"), decision: "carry_verdict", evidenceDigest: "d" }));
  const otherGate = { gate: "other_gate", originHead: "c".repeat(40), headSha: "e".repeat(40), decision: "carry_verdict", evidenceDigest: "d" };
  const comments = [{ id: 9, body: renderCarriedHeadsBody([...stale, otherGate]) }];
  const out = await carryFromPostedVerdict(marker(origin), { gate: GATE, repo: REPO, pr: 7, currentHeadSha: cur, repoRoot: s.dir, env: {}, comments, record: true, runJson: async (args) => (args[0] === "pr" ? { baseRefName: "main" } : runJson(args)) });
  assert.equal(out.carriedFrom, origin);
  const entries = parseCarriedHeads(comments);
  // The other gate's entry (different origin head) survives; this gate's stale entries are pruned.
  assert.deepEqual(entries.map((e) => e.headSha), [otherGate.headSha, cur]);
  assert.match(entries[1].evidenceDigest, /^[0-9a-f]{64}$/);
  assert.equal("evidence" in entries[1], false);
});

test("the posted record round-trips evidence text containing a comment terminator", () => {
  const entries = [{ gate: GATE, originHead: "a", headSha: "b", decision: "carry_verdict", evidence: { note: "--> <!--" } }];
  const body = renderCarriedHeadsBody(entries);
  assert.equal(body.match(/-->/g).length, 1);
  assert.deepEqual(parseCarriedHeads([{ body }]), entries);
});

test("buildPreMergeGateCheck passes with a carried marker and fails with an uncarried stale-head marker", async () => {
  const s = setup();
  const origin = s.head();
  const cur = s.mergeBase("docs/a.md");
  const evidence = (pre) => ({ currentHeadSha: cur, draftGate: { visible: true, verdict: "clean" }, preApprovalGateMarker: { ...pre, sizeOutcome: "pass", sizeTouchesT1: false } });
  const carried = await carry(s, marker(origin), cur, { written: [] });
  assert.equal(buildPreMergeGateCheck(evidence(carried), 0).ok, true);
  assert.equal(buildPreMergeGateCheck(evidence(marker(origin)), 0).ok, false);
});

// Tampered evidence at the merge-precondition seam: each case falls back to a full re-gate.
test("buildPreMergeGateCheck rejects a recorded entry whose evidence differs from the recomputation", async () => {
  const s = setup();
  const origin = s.head();
  const cur = s.mergeBase("docs/a.md");
  const written = [];
  await carry(s, marker(origin), cur, { written });
  const tampered = [{ ...written[0], evidenceDigest: "f".repeat(64) }];
  const m = marker(origin);
  const result = await carry(s, m, cur, { recorded: tampered });
  assert.deepEqual(result, m);
  const pre = { ...result, sizeOutcome: "pass", sizeTouchesT1: false };
  assert.equal(buildPreMergeGateCheck({ currentHeadSha: cur, draftGate: { visible: true, verdict: "clean" }, preApprovalGateMarker: pre }, 0).ok, false);
});

test("buildPreMergeGateCheck rejects a candidate with contractComplete false", async () => {
  const s = setup();
  const origin = s.head();
  const cur = s.mergeBase("docs/a.md");
  const written = [];
  const m = { ...marker(origin), contractComplete: false };
  const result = await carry(s, m, cur, { written });
  assert.deepEqual(result, m);
  assert.deepEqual(written, []);
  const pre = { ...result, sizeOutcome: "pass", sizeTouchesT1: false };
  assert.equal(buildPreMergeGateCheck({ currentHeadSha: cur, draftGate: { visible: true, verdict: "clean" }, preApprovalGateMarker: pre }, 0).ok, false);
});

test("fetchDraftGateEvidence reads a recorded base-only carry as current-head clean and a PR-own change as not clean", async () => {
  const s = setup();
  const origin = s.head();
  const cur = s.mergeBase("docs/a.md");
  s.git("update-ref", "refs/remotes/origin/main", "main");
  const written = [];
  await carryGateMarker(marker(origin), { gate: GATE, currentHeadSha: cur, baseRef: "origin/main", repoRoot: s.dir, record: async (e) => { written.push(e); } });
  const body = renderGateReviewCommentBody({ gate: "draft_gate", headSha: origin, repo: REPO, verdict: "clean", findingsSummary: "none", nextAction: "mark ready for review" });
  const recordBody = renderCarriedHeadsBody(written);
  const baseRefReply = { current: () => ({ code: 0, stdout: JSON.stringify({ baseRefName: "main" }), stderr: "" }) };
  const runChild = async (_cmd, args) => {
    if (args.some((a) => String(a).includes("issues/7/comments"))) {
      return { code: 0, stdout: JSON.stringify([[{ id: 1, body, created_at: "2026-01-01T00:00:00Z" }, { id: 2, body: recordBody, created_at: "2026-01-01T00:00:01Z" }]]), stderr: "" };
    }
    if (args.includes("baseRefName")) return baseRefReply.current();
    return { code: 1, stdout: "", stderr: "unavailable" };
  };
  const read = (headSha) => fetchDraftGateEvidence({ repo: REPO, pr: 7, headSha }, { env: { GH_TOKEN: "t" }, ghCommand: "gh", runChild, repoRoot: s.dir });
  assert.equal((await read(cur)).currentHeadClean, true);

  // The gh binary is missing: the REST fallback supplies baseRefName, same as the detector.
  baseRefReply.current = () => { throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }); };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/pulls\/7$/);
    return { ok: true, status: 200, statusText: "OK", headers: { get: () => null }, json: async () => ({ base: { ref: "main" }, head: { sha: cur } }) };
  };
  try {
    assert.equal((await read(cur)).currentHeadClean, true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  s.put("src/x.mjs", "changed pr blob\n"); s.git("add", "-A"); s.git("commit", "-qm", "pr edit");
  assert.equal((await read(s.head())).currentHeadClean, false);
});
