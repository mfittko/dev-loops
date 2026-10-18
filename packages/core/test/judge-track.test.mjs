import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import {
  GATE_LIGHT_LABEL,
  GATE_REDUCED_LABEL,
  GATE_FULL_LABEL,
  resolveReviewProportionality,
} from "../src/config/config.mjs";
import { resolveJudgeTrack, validateJudgeTrackRecord } from "../src/config/judge-track.mjs";

const HEAD = "a".repeat(40);
const record = (over = {}) => ({
  schemaVersion: 1,
  headSha: HEAD,
  track: "light",
  signals: [{ signal: "additive", reason: "new helper only" }],
  ...over,
});

describe("validateJudgeTrackRecord", () => {
  test("accepts a well-formed record", () => {
    assert.equal(validateJudgeTrackRecord(record()).ok, true);
  });
  test("rejects unknown keys, wrong types, unknown track, empty signals, bad sha", () => {
    for (const bad of [
      null, [], "x",
      record({ extra: 1 }),
      record({ schemaVersion: 2 }),
      record({ headSha: "abc" }),
      record({ track: "heavy" }),
      record({ signals: [] }),
      record({ signals: [{ signal: "", reason: "r" }] }),
      record({ signals: [{ signal: "s", reason: "r", more: 1 }] }),
    ]) {
      assert.equal(validateJudgeTrackRecord(bad).ok, false, JSON.stringify(bad));
    }
  });
});

describe("resolveJudgeTrack", () => {
  const ok = (track, label) => resolveJudgeTrack({ record: record({ track }), labels: [label], headSha: HEAD });
  test("a matching record and label lower the track", () => {
    assert.deepEqual(ok("light", GATE_LIGHT_LABEL), { track: "light", reason: "judge_light" });
    assert.deepEqual(ok("reduced", GATE_REDUCED_LABEL), { track: "reduced", reason: "judge_reduced" });
  });
  test("everything else fails closed to full with a specific reason", () => {
    const cases = [
      [{ labels: [GATE_LIGHT_LABEL], headSha: HEAD }, "judge_record_absent"],
      [{ record: { track: "light" }, labels: [GATE_LIGHT_LABEL], headSha: HEAD }, "judge_record_invalid"],
      [{ record: record({ track: "bogus" }), labels: [GATE_LIGHT_LABEL], headSha: HEAD }, "judge_record_invalid"],
      [{ record: record(), labels: [GATE_LIGHT_LABEL], headSha: "b".repeat(40) }, "judge_head_mismatch"],
      [{ record: record(), labels: [GATE_LIGHT_LABEL] }, "judge_head_mismatch"],
      [{ record: record(), labels: [], headSha: HEAD }, "judge_label_unmatched"],
      [{ record: record(), labels: [GATE_REDUCED_LABEL], headSha: HEAD }, "judge_label_unmatched"],
      [{ record: record(), labels: [GATE_LIGHT_LABEL, GATE_REDUCED_LABEL], headSha: HEAD }, "judge_label_unmatched"],
      [{ record: record({ track: "full" }), labels: [], headSha: HEAD }, "judge_full"],
    ];
    for (const [input, reason] of cases) {
      assert.deepEqual(resolveJudgeTrack(input), { track: "full", reason });
    }
  });
});

describe("resolveReviewProportionality judgeTrack", () => {
  const config = () => ({
    version: 1,
    localImplementation: { lightMode: { enabled: true, maxFiles: 2, maxLines: 20 } },
    gates: { draft: { tiers: [{ name: "docs", match: { kinds: ["docs"] }, angles: ["link-check"] }] } },
  });
  const PASS = { outcome: "pass", tierLogicLoc: { t1: 0 } };
  const plan = (gate, facts) => resolveReviewProportionality(config(), gate, { sizeOutcome: PASS, ...facts });
  const small = { scope: { filesChanged: 1, linesChanged: 5 }, changedFiles: ["docs/a.md"] };
  const big = { scope: { filesChanged: 1, linesChanged: 400 }, changedFiles: ["docs/a.md"] };
  const pr2614 = ["packages/core/src/analysis/new-helper.mjs", "skills/docs/some-section.md", "test/new-helper.test.mjs", "changes/x.md"];

  for (const gate of ["draft", "preApproval"]) {
    test(`${gate}: default is full; light on a small non-risk diff; reduced when over the cap`, () => {
      assert.equal(plan(gate, small).track, "full");
      const light = plan(gate, { ...small, judgeTrack: "light" });
      assert.deepEqual([light.mode, light.track, light.trackReason], ["inline", "light", "judge_light"]);
      const degraded = plan(gate, { ...big, judgeTrack: "light" });
      assert.deepEqual([degraded.mode, degraded.reason, degraded.track, degraded.trackReason],
        ["full_fanout", "over_threshold", "reduced", "judge_light_degraded_to_reduced"]);
      assert.equal(plan(gate, { ...big, judgeTrack: "reduced" }).track, "reduced");
    });

    test(`${gate}: the judge never changes mode, angles, groups or floors`, () => {
      for (const facts of [small, big]) {
        const base = plan(gate, facts);
        const judged = plan(gate, { ...facts, judgeTrack: "light" });
        for (const k of ["mode", "angles", "groups", "reason", "floors"]) assert.deepEqual(judged[k], base[k], k);
      }
    });
  }

  test("PR-shaped fixture lowers; the same fixture plus a risk-path file stays full", () => {
    const scope = { filesChanged: 4, linesChanged: 231 };
    const lowered = plan("draft", { scope, changedFiles: pr2614, judgeTrack: "light" });
    assert.equal(lowered.track, "reduced");
    const risky = plan("draft", { scope, changedFiles: [...pr2614, "scripts/loop/some-gate-helper.mjs"], judgeTrack: "light" });
    assert.deepEqual([risky.track, risky.trackReason, risky.mode], ["full", "risk_floor", "full_fanout"]);
  });

  test("a one-line change on a risk path stays full with a lowering judge track", () => {
    const r = plan("draft", { scope: { filesChanged: 1, linesChanged: 1 }, changedFiles: ["scripts/loop/some-gate-helper.mjs"], judgeTrack: "light" });
    assert.deepEqual([r.track, r.mode], ["full", "full_fanout"]);
  });

  test("each floor keeps full_fanout mode and track full", () => {
    const floors = [
      { ...small, sizeOutcome: { outcome: "escalate", tierLogicLoc: { t1: 0 } } },
      { ...small, sizeOutcome: { outcome: "block", tierLogicLoc: { t1: 0 } } },
      { ...small, sizeOutcome: { outcome: "pass", tierLogicLoc: { t1: 3 } } },
      { ...small, changedFiles: undefined },
      { ...small, changedFiles: ["data/blob.unknownkind"] },
      { ...big, changedFiles: undefined },
      { ...big, sizeOutcome: { outcome: "block", tierLogicLoc: { t1: 0 } } },
    ];
    for (const facts of floors) {
      const r = plan("draft", { ...facts, judgeTrack: "reduced" });
      assert.deepEqual([r.mode, r.track], ["full_fanout", "full"], JSON.stringify(facts));
    }
  });

  test("gate:full label wins over a lowering judge track", () => {
    const r = plan("draft", { ...small, hasFullLabel: true, judgeTrack: "light" });
    assert.deepEqual([r.track, r.trackReason], ["full", "gate_full_label"]);
    assert.equal(GATE_FULL_LABEL, "gate:full");
  });
});
