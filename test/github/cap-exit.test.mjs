// Issue 3460: the cap exit (GATE-EXEC-ROUND-CAP-EXIT) over real cap-round ledgers in a scratch repo. Only the PR reviews are a fixture.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "bun:test";

import { buildLogPath } from "../../scripts/github/_gate-artifact-paths.mjs";
import { capExitHolds, resolveCapExitRound, resolveDraftCapRoundFact } from "../../scripts/github/write-gate-context.mjs";
import { draftGatePostedHeads } from "../../scripts/github/_gate-finding-surface.mjs";
import { initGitFixture } from "../_helpers.mjs";

const REPO = "owner/repo";
const PR = 70;
const CAP_HEAD = "a".repeat(40);
const roots = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const act = (n, over = {}) => ({ severity: "medium", summary: `guard ${n} missing`, files: [`src/f${n}.mjs`], line: n, angle: "correctness", judgeDisposition: "act", judgeTitle: `Guard ${n}`, judgeFix: "add it", ...over });
const review = (head, round, verdict, who = { login: "operator", type: "User", assoc: "OWNER" }) => ({ author: { login: who.login, type: who.type }, authorAssociation: who.assoc, body: `<!-- dev-loops:gate-findings-review draft_gate ${head.slice(0, 7)} round=${round} -->\n**Verdict:** ${verdict}` });
const runChild = async (_cmd, args) => (args?.includes("user") ? { code: 0, stdout: JSON.stringify({ login: "agent" }), stderr: "" } : { code: 1, stdout: "", stderr: "stub" });

/** A scratch repo with four closed draft_gate ledgers (the cap is 4); the last one is the cap round at CAP_HEAD. No delta record exists. */
function world(findings, verdict = findings.length === 0 ? "clean" : "findings_present") {
  const root = mkdtempSync(path.join(os.tmpdir(), "cap-exit-"));
  roots.push(root);
  initGitFixture(root, { branch: "main" });
  [..."123", "a"].forEach((c, i) => {
    const headSha = c.repeat(40);
    const file = path.resolve(root, buildLogPath({ repo: REPO, pr: PR, gate: "draft_gate", headSha, tmpRoot: path.join(root, "tmp") }));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ repo: REPO, pr: PR, gate: "draft_gate", headSha, verdict: i === 3 ? verdict : "clean", loggedAt: `2026-11-0${i + 1}T00:00:00.000Z`, findings: i === 3 ? findings : [] }));
  });
  return root;
}
const fact = (root, reviews, over = {}) => resolveDraftCapRoundFact(
  { repo: REPO, pr: PR, currentHeadSha: "b".repeat(40), prData: { isDraft: true, baseRefName: "main", reviews } },
  { repoRoot: root, trustRuntime: { runChild }, ...over },
);

test("capExitHolds: a posted unblocked review at the cap-round head with the cap round number, for a clean and a findings round", () => {
  const round = (findings) => ({ round: 4, log: { headSha: CAP_HEAD, findings } });
  const posted = (over = {}) => [{ head: CAP_HEAD.slice(0, 7), round: 4, verdict: "findings_present", ...over }];
  assert.equal(capExitHolds(round([]), posted({ verdict: "clean" })), true, "clean round");
  assert.equal(capExitHolds(round([act(1)]), posted()), true, "findings round");
  assert.equal(capExitHolds(null, posted()), false, "no cap round");
  assert.equal(capExitHolds(round([act(1)]), []), false, "no posted review");
  assert.equal(capExitHolds(round([act(1)]), posted({ head: "bbbbbbb" })), false, "review at another head");
  assert.equal(capExitHolds(round([act(1)]), posted({ round: 3 })), false, "another header round");
  assert.equal(capExitHolds(round([act(1)]), posted({ verdict: "blocked" })), false, "posted blocked verdict");
  assert.equal(capExitHolds(round([act(1, { severity: "high", judgeFix: undefined })]), posted()), false, "ledger blocker: high act without a fix");
  assert.equal(capExitHolds(round([act(1, { severity: "question" })]), posted()), false, "ledger blocker: question act");
  assert.deepEqual(draftGatePostedHeads([review(CAP_HEAD, 4, "blocked").body]), [{ head: CAP_HEAD.slice(0, 7), round: 4, verdict: "blocked" }]);
});

test("resolveDraftCapRoundFact reaches capRoundFixed for a clean and a findings cap round with no delta record on disk", async () => {
  assert.deepEqual(await fact(world([]), [review(CAP_HEAD, 4, "clean")]), { capRoundFixed: true, failure: null });
  assert.deepEqual(await fact(world([act(1), act(2)]), [review(CAP_HEAD, 4, "findings_present")]), { capRoundFixed: true, failure: null });
});

test("the exit stays false for an untrusted author, another head, another header round and no posted review (the chain proof decides)", async () => {
  const root = world([act(1)]);
  const stranger = { login: "stranger", type: "User", assoc: "NONE" };
  for (const [name, reviews] of [["untrusted author", [review(CAP_HEAD, 4, "findings_present", stranger)]], ["other head", [review("c".repeat(40), 4, "findings_present")]], ["other round", [review(CAP_HEAD, 3, "findings_present")]], ["no review", []]]) {
    const result = await fact(root, reviews);
    assert.equal(result.capRoundFixed, false, name);
  }
});

test("a blocked cap round keeps the chain proof: no delta record means capRoundFixed false (AC4)", async () => {
  assert.equal((await fact(world([act(1)]), [review(CAP_HEAD, 4, "blocked")])).capRoundFixed, false, "posted blocked verdict");
  assert.equal((await fact(world([act(1, { severity: "high", judgeFix: undefined })]), [review(CAP_HEAD, 4, "findings_present")])).capRoundFixed, false, "ledger blocker");
});

test("the exit is skipped when the caller turns the posted-review check off (the sealed cap-round post itself)", async () => {
  const result = await fact(world([act(1)]), [review(CAP_HEAD, 4, "findings_present")], { requirePostedCleanCap: false });
  assert.equal(result.capRoundFixed, false, "no chain record: the chain proof decides");
});

test("resolveCapExitRound is the one read every local caller shares", async () => {
  const root = world([act(1)]);
  const heads = [{ head: CAP_HEAD.slice(0, 7), round: 4, verdict: "findings_present" }];
  const options = { repo: REPO, pr: PR, headSha: "b".repeat(40) };
  assert.equal((await resolveCapExitRound(options, { repoRoot: root, postedHeads: heads }))?.log.headSha, CAP_HEAD);
  assert.equal(await resolveCapExitRound(options, { repoRoot: root, postedHeads: [] }), null);
  assert.equal(await resolveCapExitRound(options, { repoRoot: path.join(root, "missing"), postedHeads: heads }), null);
});

test("AC6 fan-in seeds each open act item of the cap round as a finding (a capClosed item stays context), whatever a delta record says", async () => {
  const { consolidateFanin, toFindingsLogShape, pastCapBlockers } = await import("@dev-loops/core/loop/gate-fanin");
  const { seedCapRoundActFindings } = await import("../../scripts/loop/consolidate-fanin.mjs");
  const { capRoundActList } = await import("../../scripts/github/write-gate-context.mjs");
  const closed = act(3, { judgeDisposition: "defer", capClosed: true });
  const cap = capRoundActList([act(1), act(2, { severity: "high", judgeFix: undefined }), closed], CAP_HEAD);
  assert.equal(cap.length, 2, "the capClosed item is not an act item");
  const artifacts = [{ angle: "correctness", verdict: "clean", findings: [] }];
  seedCapRoundActFindings(artifacts, cap);
  const { verdict, findings } = consolidateFanin({ angleResults: artifacts });
  assert.equal(verdict, "findings_present");
  const seeded = toFindingsLogShape(findings);
  assert.equal(seeded.length, 2);
  assert.ok(seeded.every((f) => /^cap:[0-9a-f]{16}$/.test(f.defectKey)));
  // The verdict poster applies the past-cap blocker rule to the seeded items once the judge has disposed them.
  const judged = (f, over) => ({ ...f, judgeDisposition: "act", ...over });
  assert.equal(pastCapBlockers([judged(seeded[0], { severity: "medium", judgeFix: "x" })], { round: 4, cap: 4 }).length, 0, "an act medium blocks nothing by itself");
  assert.equal(pastCapBlockers([judged(seeded[1], { severity: "high" })], { round: 4, cap: 4 }).length, 1, "a seeded high without a fix blocks clean");
  assert.equal(pastCapBlockers([judged(seeded[0], { severity: "medium", judgeDisposition: "defer", failOpen: true })], { round: 4, cap: 4 }).length, 1, "a fail-open medium blocks clean");
});

test("AC6 seeding keeps a blocked artifact blocked, skips an item with no angle, and tolerates an artifact without findings", async () => {
  const { consolidateFanin } = await import("@dev-loops/core/loop/gate-fanin");
  const { seedCapRoundActFindings } = await import("../../scripts/loop/consolidate-fanin.mjs");
  const item = { fingerprint: "0123456789abcdef", severity: "medium", summary: "guard missing", angle: "correctness" };
  const blocked = [{ angle: "correctness", verdict: "blocked", findings: [] }];
  seedCapRoundActFindings(blocked, [item]);
  assert.equal(blocked[0].verdict, "blocked");
  assert.equal(consolidateFanin({ angleResults: blocked }).verdict, "blocked");
  const bare = [{ angle: "correctness", verdict: "clean" }];
  seedCapRoundActFindings(bare, [item, { ...item, angle: undefined }]);
  assert.equal(bare.length, 1, "an item with no angle is skipped");
  assert.equal(bare[0].findings.length, 1);
});

test("AC6 a seeded item whose angle has no artifact rides a synthetic artifact with no provenance row, and the next round's carry-forward accepts it", async () => {
  const { seedCapRoundActFindings, deriveFaninProvenance } = await import("../../scripts/loop/consolidate-fanin.mjs");
  const { buildCarryForwardPlan } = await import("../../scripts/github/resolve-angle-carry-forward.mjs");
  const artifacts = [{ angle: "coverage", verdict: "clean", findings: [], headSha: CAP_HEAD }];
  seedCapRoundActFindings(artifacts, [{ fingerprint: "0123456789abcdef", severity: "medium", summary: "guard missing", angle: "correctness" }]);
  assert.equal(artifacts.length, 2);
  const { perAngle } = deriveFaninProvenance(artifacts, { units: [{ angles: ["coverage"], executionIdentity: "e1", group: null }] }, CAP_HEAD, []);
  assert.deepEqual(perAngle.map((p) => p.angle), ["coverage"]);
  const log = { headSha: "aaaaaaa", verdict: "findings_present", provenance: { distinctReviewers: 1, perAngle: [{ angle: "coverage", reviewer: "r1" }] }, findings: [{ angle: "correctness", severity: "medium", summary: "guard missing", defectKey: "cap:0123456789abcdef" }] };
  assert.deepEqual(buildCarryForwardPlan({ log, changedFiles: ["docs/guide.md"] }).carried.map((c) => c.angle), ["coverage"]);
  assert.throws(() => buildCarryForwardPlan({ log: { ...log, findings: [{ ...log.findings[0], defectKey: "other" }] }, changedFiles: ["docs/guide.md"] }), /matches no provenance\.perAngle entry/);
});

test("AC1 a stale delta record of another act set on disk still gives capRoundFixed true", async () => {
  const root = world([act(1)]);
  mkdirSync(path.join(root, "tmp", "gate-delta", "owner-repo", `pr-${PR}`), { recursive: true });
  writeFileSync(path.join(root, "tmp", "gate-delta", "owner-repo", `pr-${PR}`, "stale.json"), JSON.stringify({ baseline: "9".repeat(40), candidateHead: "8".repeat(40), refs: ["other-act-set"] }));
  assert.deepEqual(await fact(root, [review(CAP_HEAD, 4, "findings_present")]), { capRoundFixed: true, failure: null });
});

test("AC4 a blocked cap round with a posted review and no delta record reports blocked; with a clearing chain it keeps today's result", async () => {
  const { evaluatePrGateCoordination, PR_CHECKPOINT_ACTION } = await import("@dev-loops/core/loop/pr-gate-coordination");
  const { DISPOSITION, STATE } = await import("@dev-loops/core/loop/copilot-loop-state");
  const root = world([act(1, { severity: "high", judgeFix: undefined })]);
  const blocked = await fact(root, [review(CAP_HEAD, 4, "findings_present")]);
  assert.equal(blocked.capRoundFixed, false);
  const marker = { visible: true, headSha: "bbbbbbb", verdict: "findings_present", contractComplete: true };
  const result = evaluatePrGateCoordination({
    pr: PR, currentHeadSha: "b".repeat(40), prDraft: true, lifecycleState: STATE.PR_DRAFT, loopDisposition: DISPOSITION.ACTION_REQUIRED, ciStatus: "success",
    draftGate: marker, draftGateMarker: marker, unresolvedGateThreadCount: 0, draftCapRoundFixed: blocked.capRoundFixed, draftCapRoundFailure: blocked.failure ?? "no_clearing_record", draftRoundRefused: true,
  });
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  // A clearing chain (the resolver proves the cap round fixed) keeps today's result: the chain proof decides.
  const chained = await fact(root, [review(CAP_HEAD, 4, "findings_present")], { resolve: async () => ({ log: { headSha: CAP_HEAD, findings: [] }, round: 4, residue: [] }) });
  assert.equal(chained.capRoundFixed, true);
});
