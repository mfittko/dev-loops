import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { composeCheckpointVerdict } from "../../scripts/github/upsert-checkpoint-verdict.mjs";
import { fingerprintFinding, resolveGateRound } from "../../scripts/github/_gate-finding-surface.mjs";
import { evaluateRoundCap, keepKnownResurfaces, readRoundCapState, stampCapClosed } from "../../scripts/github/_gate-round-cap.mjs";
import { readClosedPriorRoundLogs } from "../../scripts/github/write-gate-context.mjs";
import { writeGateFindingsLog } from "../../scripts/github/write-gate-findings-log.mjs";

const REPO = "owner/repo";
const PR = 42;
const GATE = "draft_gate";
const sha = (c) => c.repeat(40);
const HEAD = sha("f");

async function withRepo(devloops, fn) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "gate-round-cap-"));
  try {
    if (devloops !== undefined) await writeFile(path.join(repoRoot, ".devloops"), devloops, "utf8");
    const dir = path.join(repoRoot, "tmp", "gate-findings", "owner-repo", `pr-${PR}`);
    await mkdir(dir, { recursive: true });
    return await fn({ repoRoot, tmpRoot: path.join(repoRoot, "tmp"), dir });
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

const ledger = (headSha, extra = {}) => ({ repo: REPO, pr: PR, gate: GATE, headSha, verdict: "findings_present", loggedAt: `2026-01-01T00:00:0${headSha[0] === "a" ? 1 : 2}Z`, findings: [], ...extra });
const putLedger = (dir, headSha, extra, name = `${GATE}-${headSha}.json`) => writeFile(path.join(dir, name), typeof extra === "string" ? extra : JSON.stringify(ledger(headSha, extra)), "utf8");
const capConfig = (maxReviewRounds) => ({ version: 1, gates: { draft: { maxReviewRounds } } });
const state = (overrides = {}) => ({ cap: 4, round: 2, pastCap: false, ...overrides });
const act = (severity, extra = {}) => ({ severity, angle: "correctness", summary: `${severity} act`, judgeDisposition: "act", ...extra });

test("round count: one round per eligible ledger, never an angle or dispatch unit; the round being posted counts", async () => {
  await withRepo(undefined, async ({ repoRoot, tmpRoot, dir }) => {
    const perAngle = { provenance: { distinctReviewers: 5, perAngle: ["a", "b", "c", "d", "e"].map((angle) => ({ angle, reviewer: `r-${angle}` })) } };
    const grouped = { provenance: { distinctReviewers: 1, perAngle: [{ angle: "a", reviewer: "r", group: "g" }, { angle: "b", reviewer: "r", group: "g" }] } };
    await putLedger(dir, sha("a"), perAngle);
    await putLedger(dir, sha("b"), grouped);
    await putLedger(dir, HEAD, perAngle);
    const result = await readRoundCapState({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD, tmpRoot }, capConfig(3), repoRoot);
    assert.equal(result.round, 3);
    assert.equal(result.pastCap, true);
    const below = await readRoundCapState({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD, tmpRoot }, capConfig(4), repoRoot);
    assert.equal(below.pastCap, false);
  });
});

test("round count: an unreadable in-range ledger counts; foreign, blocked and sidecar files do not", async () => {
  await withRepo(undefined, async ({ repoRoot, tmpRoot, dir }) => {
    await putLedger(dir, sha("a"), "{not json");
    await putLedger(dir, sha("b"), { pr: 99 });
    await putLedger(dir, sha("c"), { verdict: "blocked" });
    await putLedger(dir, sha("d"), {}, `${GATE}-${sha("d")}.act-list.json`);
    const logs = await readClosedPriorRoundLogs({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD, tmpRoot }, { repoRoot, keepUnreadable: true });
    assert.deepEqual(logs, [null]);
    const dropped = await readClosedPriorRoundLogs({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD, tmpRoot }, { repoRoot });
    assert.deepEqual(dropped, []);
  });
});

test("maxReviewRounds 0 never reaches the cap", async () => {
  await withRepo(undefined, async ({ repoRoot, tmpRoot, dir }) => {
    for (const c of "abcdefgh") await putLedger(dir, sha(c), {});
    const result = await readRoundCapState({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD, tmpRoot }, capConfig(0), repoRoot);
    assert.equal(result.pastCap, false);
    assert.equal(result.cap, 0);
  });
});

test("only draft_gate is capped", async () => {
  await withRepo(undefined, async ({ repoRoot, tmpRoot }) => {
    const result = await readRoundCapState({ repo: REPO, pr: PR, gate: "pre_approval_gate", headSha: HEAD, tmpRoot }, capConfig(1), repoRoot);
    assert.equal(result.pastCap, false);
  });
});

test("resolveGateRound posts round 2 for a second head with round 1 sidecars present", async () => {
  await withRepo(undefined, async ({ repoRoot, tmpRoot, dir }) => {
    await putLedger(dir, sha("a"), {});
    await putLedger(dir, HEAD, {});
    for (const suffix of ["act-list", "judged-ledger", "fanin-out", "ledger-in", "approvals", "size-budget"]) {
      await putLedger(dir, sha("a"), {}, `${GATE}-${sha("a")}.${suffix}.json`);
    }
    const round = await resolveGateRound({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD, reviews: [], issueComments: [], tmpRoot, repoRoot });
    assert.equal(round, 2);
  });
});

test("resurfaces: valid, unknown, foreign-PR and missing fingerprints", async () => {
  await withRepo("version: 1\ngates:\n  draft:\n    maxReviewRounds: 4\n", async ({ repoRoot, tmpRoot, dir }) => {
    const priorFinding = { severity: "medium", angle: "correctness", summary: "prior act", judgeDisposition: "act" };
    const foreignFinding = { severity: "medium", angle: "correctness", summary: "foreign act", judgeDisposition: "act" };
    await putLedger(dir, sha("a"), { findings: [priorFinding] });
    await putLedger(dir, sha("b"), { pr: 99, findings: [foreignFinding] });
    const findings = ["one", "two", "three", "four"].map((n) => ({ severity: "medium", angle: "correctness", summary: `new ${n}` }));
    const judgeVerdict = path.join(repoRoot, "judge.json");
    const dispositions = [fingerprintFinding(priorFinding), "0123456789abcdef", fingerprintFinding(foreignFinding), undefined].map((resurfaces, index) => (
      { index, disposition: "act", rationale: "AC-1", ...(resurfaces ? { resurfaces } : {}) }
    ));
    await writeFile(judgeVerdict, JSON.stringify({ headSha: HEAD, scopeDrift: { verdict: "none", rationale: "r", driftedAreas: [] }, dispositions }), "utf8");
    const { log } = await writeGateFindingsLog({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD, verdict: "findings_present", findings: JSON.stringify(findings), judgeVerdict, tmpRoot }, { repoRoot });
    assert.deepEqual(log.findings.map((f) => f.resurfaces), [fingerprintFinding(priorFinding), undefined, undefined, undefined]);
  });
});

test("keepKnownResurfaces drops a mark on a non-act finding", () => {
  const kept = keepKnownResurfaces([{ judgeDisposition: "defer", resurfaces: "abc" }, { judgeDisposition: "act", resurfaces: "abc" }], new Set(["abc"]));
  assert.deepEqual(kept.map((f) => f.resurfaces), [undefined, "abc"]);
});

test("convergence: a re-surfaced medium below the cap runs another round; a re-surfaced low ends the sequence", () => {
  const runs = evaluateRoundCap([act("medium", { resurfaces: "x" })], state({ round: 2 }));
  assert.deepEqual(runs, { runNextRound: true, blockers: [] });
  const stops = evaluateRoundCap([act("low", { resurfaces: "x" })], state({ round: 2 }));
  assert.equal(stops.runNextRound, false);
  assert.deepEqual(stops.blockers.map((b) => b.kind), ["round_cap_reached"]);
  const newLow = evaluateRoundCap([act("low")], state({ round: 2 }));
  assert.deepEqual(newLow, { runNextRound: true, blockers: [] });
});

test("past the cap a re-surfaced medium blocks", () => {
  const result = evaluateRoundCap([act("medium", { resurfaces: "x" })], state({ round: 4, pastCap: true }));
  assert.equal(result.runNextRound, false);
  assert.deepEqual(result.blockers.map(({ kind, item }) => ({ kind, item })), [{ kind: "round_cap_reached", item: "[medium] medium act" }]);
  assert.match(result.blockers[0].reason, /GATE-EXEC-ROUND-CAP/);
});

test("past the cap every new act severity blocks and composes blocked", () => {
  for (const severity of ["high", "medium", "low", "nit"]) {
    const { blockers } = evaluateRoundCap([act(severity)], state({ round: 4, pastCap: true }));
    assert.deepEqual(blockers.map((b) => b.kind), ["round_cap_reached"], severity);
    assert.equal(composeCheckpointVerdict({ reviewVerdict: "findings_present", blockers }), "blocked");
  }
});

test("maxReviewRounds 0 leaves the verdict composition unchanged", () => {
  const result = evaluateRoundCap([act("high"), act("low", { resurfaces: "x" })], { cap: 0, round: 9, pastCap: false });
  assert.deepEqual(result, { runNextRound: true, blockers: [] });
});

test("past the cap: low defer and nit reject close clean; medium reject, high defer, missing disposition and unknown severity block", () => {
  const past = state({ round: 4, pastCap: true });
  const closed = (severity, judgeDisposition) => ({ severity, angle: "docs", summary: `${severity} ${judgeDisposition}`, judgeDisposition });
  const clean = evaluateRoundCap([closed("low", "defer"), closed("nit", "reject")], past);
  assert.deepEqual(clean.blockers, []);
  assert.equal(composeCheckpointVerdict({ reviewVerdict: "clean", blockers: clean.blockers }), "clean");
  const cases = [closed("medium", "reject"), closed("high", "defer"), { severity: "low", angle: "docs", summary: "no disposition" }, closed("bogus", "defer")];
  for (const finding of cases) {
    const { blockers } = evaluateRoundCap([finding], past);
    assert.deepEqual(blockers.map((b) => b.kind), ["severity_disagreement"], finding.summary);
    assert.equal(composeCheckpointVerdict({ reviewVerdict: "clean", blockers }), "blocked");
  }
});

test("capClosed is stamped on a past-cap defer or reject; a locatable question stays open", () => {
  const findings = [
    { severity: "low", judgeDisposition: "defer" },
    { severity: "nit", judgeDisposition: "reject" },
    { severity: "question", judgeDisposition: "reject", files: ["a.mjs"], line: 3 },
    { severity: "question", judgeDisposition: "defer" },
    { severity: "medium", judgeDisposition: "act" },
  ];
  stampCapClosed(findings, { cap: 4, round: 4, pastCap: true });
  assert.deepEqual(findings.map((f) => f.capClosed), [
    { judgeDisposition: "defer", severity: "low", round: 4, cap: 4 },
    { judgeDisposition: "reject", severity: "nit", round: 4, cap: 4 },
    undefined,
    { judgeDisposition: "defer", severity: "question", round: 4, cap: 4 },
    undefined,
  ]);
  const below = [{ severity: "low", judgeDisposition: "defer" }];
  stampCapClosed(below, { cap: 4, round: 3, pastCap: false });
  assert.equal(below[0].capClosed, undefined);
});

test("writeGateFindingsLog records capClosed past the cap and nothing below it", async () => {
  await withRepo("version: 1\ngates:\n  draft:\n    maxReviewRounds: 2\n", async ({ repoRoot, tmpRoot, dir }) => {
    await putLedger(dir, sha("a"), {});
    const findings = [{ severity: "low", angle: "docs", summary: "reword" }, { severity: "nit", angle: "docs", summary: "style" }];
    const judgeVerdict = path.join(repoRoot, "judge.json");
    await writeFile(judgeVerdict, JSON.stringify({
      headSha: HEAD,
      scopeDrift: { verdict: "none", rationale: "r", driftedAreas: [] },
      dispositions: [
        { index: 0, disposition: "defer", rationale: "out of scope", followUpDraft: { title: "t", body: "b" } },
        { index: 1, disposition: "reject", rationale: "non-goal" },
      ],
    }), "utf8");
    const write = (headSha) => writeGateFindingsLog({ repo: REPO, pr: PR, gate: GATE, headSha, verdict: "clean", findings: JSON.stringify(findings), judgeVerdict, tmpRoot }, { repoRoot });
    const { path: logPath, log } = await write(HEAD);
    assert.deepEqual(log.findings.map((f) => f.capClosed), [
      { judgeDisposition: "defer", severity: "low", round: 2, cap: 2 },
      { judgeDisposition: "reject", severity: "nit", round: 2, cap: 2 },
    ]);
    assert.equal(JSON.parse(await readFile(path.resolve(repoRoot, logPath), "utf8")).findings[0].capClosed.cap, 2);
    await rm(path.join(dir, `${GATE}-${sha("a")}.json`));
    await rm(path.join(dir, `${GATE}-${HEAD}.json`));
    const first = await write(sha("e"));
    assert.equal(first.log.findings[0].capClosed, undefined);
  });
});
