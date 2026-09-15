import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, test } from "bun:test";

import { buildExecutionUnitRecord } from "../src/loop/execution-record.mjs";
import { enforceRoleBudget } from "../src/loop/role-budget-bound.mjs";
import { enforceReviewerUnitBound } from "../src/loop/reviewer-unit-bound.mjs";
import { buildWatchCycleExecutionRecord } from "../../../scripts/loop/run-watch-cycle.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "execution-replay", "pipeline.json"), "utf8"),
);

/**
 * Before/after execution-record replay (issue 2157 slice b2, AC3): drives the
 * SAME 5-role pipeline (coordinator_phase, reviewer_unit, judge_round,
 * fixer_pass, watch_cycle) through its REAL production primitive twice — once
 * for the fixture's "before" run, once for "after" — builds one compact
 * execution-unit record per unit FROM the primitive's own validated output
 * (never a hand-built record), and aggregates a phase-level before/after
 * delta report. Mirrors review-lineage-e2e-fixture.test.mjs's drive-the-real-
 * pipeline shape.
 */
function buildRoleBudgetRecord({ role, run, headSha, consumed, snapshot, harness }) {
  const verdict = enforceRoleBudget({ unit: { role, run, gateContext: { headSha } }, consumed });
  assert.equal(verdict.ok, true, `${role} must stay within budget for this fixture`);
  return buildExecutionUnitRecord({
    harness,
    role,
    identity: { headSha: verdict.unit.gateContext.headSha, unit: run },
    promptBytes: snapshot.promptBytes,
    contextBytes: snapshot.contextBytes,
    turns: verdict.consumed.modelTurns,
    toolCalls: verdict.consumed.toolCalls,
    providerTokens: snapshot.providerTokens,
    localToolTimeMs: snapshot.localToolTimeMs,
    childWallTimeMs: snapshot.childWallTimeMs,
    waitOwner: null,
    outcome: "ok",
  });
}

function buildReviewerRecord({ headSha, snapshot, harness }) {
  const verdict = enforceReviewerUnitBound({
    unit: { run: snapshot.run, gateContext: { headSha }, angles: snapshot.angles },
    consumed: snapshot.consumed,
    completedAngles: snapshot.completedAngles,
  });
  assert.equal(verdict.ok, true, "reviewer_unit must fully cover its assigned angles within budget for this fixture");
  return buildExecutionUnitRecord({
    harness,
    role: "reviewer_unit",
    identity: { headSha: verdict.unit.gateContext.headSha, unit: verdict.unit.run },
    promptBytes: snapshot.promptBytes,
    contextBytes: snapshot.contextBytes,
    turns: verdict.consumed.modelTurns,
    toolCalls: verdict.consumed.toolCalls,
    providerTokens: snapshot.providerTokens,
    localToolTimeMs: snapshot.localToolTimeMs,
    childWallTimeMs: snapshot.childWallTimeMs,
    waitOwner: null,
    outcome: "ok",
  });
}

/** Drive every real primitive for one fixture run ("before" or "after") and return its 5 records. */
function driveRun(run, harness) {
  const { headSha, units } = run;
  return [
    buildRoleBudgetRecord({ role: "coordinator_phase", run: units.coordinator_phase.run, headSha, consumed: units.coordinator_phase.consumed, snapshot: units.coordinator_phase, harness }),
    buildReviewerRecord({ headSha, snapshot: units.reviewer_unit, harness }),
    buildRoleBudgetRecord({ role: "judge_round", run: units.judge_round.run, headSha, consumed: units.judge_round.consumed, snapshot: units.judge_round, harness }),
    buildRoleBudgetRecord({ role: "fixer_pass", run: units.fixer_pass.run, headSha, consumed: units.fixer_pass.consumed, snapshot: units.fixer_pass, harness }),
    buildWatchCycleExecutionRecord({
      owner: units.watch_cycle.owner,
      cycleDisposition: units.watch_cycle.cycleDisposition,
      headSha,
      harness,
      toolCalls: units.watch_cycle.toolCalls,
      localToolTimeMs: units.watch_cycle.localToolTimeMs,
    }),
  ];
}

/** Phase-level aggregate over one run's records. Unavailable provider-token dims are counted, never zero-filled into the sum. */
function aggregatePhase(records) {
  const totals = { promptBytes: 0, contextBytes: 0, turns: 0, toolCalls: 0, localToolTimeMs: 0 };
  let providerTokensMeasured = 0;
  let unitsWithUnavailableProviderTokens = 0;
  for (const record of records) {
    totals.promptBytes += record.metrics.promptBytes;
    totals.contextBytes += record.metrics.contextBytes;
    totals.turns += record.metrics.turns;
    totals.toolCalls += record.metrics.toolCalls;
    totals.localToolTimeMs += record.metrics.localToolTimeMs;
    if (record.hasUnavailableProviderMetric) {
      unitsWithUnavailableProviderTokens += 1;
    } else {
      providerTokensMeasured += record.providerTokens.input.value + record.providerTokens.output.value + record.providerTokens.cacheRead.value;
    }
  }
  return { ...totals, providerTokensMeasured, unitsWithUnavailableProviderTokens, unitCount: records.length };
}

/** Before/after delta report. NO fixed percentage-savings claim (mirrors cache-telemetry-evidence's aggregate.report honesty). */
function buildDeltaReport(before, after) {
  const deltaTurns = after.turns - before.turns;
  const deltaToolCalls = after.toolCalls - before.toolCalls;
  const deltaTokens = after.providerTokensMeasured - before.providerTokensMeasured;
  const sign = (n) => (n >= 0 ? `+${n}` : `${n}`);
  return `after run: ${after.turns} model turns / ${after.toolCalls} tool calls / ${after.providerTokensMeasured} measured provider tokens across ${after.unitCount} units (before run: ${before.turns} turns / ${before.toolCalls} tool calls / ${before.providerTokensMeasured} tokens across ${before.unitCount} units); delta ${sign(deltaTurns)} turns, ${sign(deltaToolCalls)} tool calls, ${sign(deltaTokens)} measured provider tokens — ${before.unitsWithUnavailableProviderTokens} before / ${after.unitsWithUnavailableProviderTokens} after unit(s) reported no observable provider-token telemetry and are excluded from the token sum, never zero-filled`;
}

describe("execution-record before/after replay (issue 2157 slice b2, AC3)", () => {
  test("every unit's record is derived from its real primitive's own validated output, not a hand-built bag", () => {
    const beforeRecords = driveRun(FIXTURE.runs.before, FIXTURE.harness);
    for (const record of beforeRecords) {
      assert.equal(record.headSha, FIXTURE.runs.before.headSha);
      assert.equal(record.harness, FIXTURE.harness);
    }
    assert.deepEqual(beforeRecords.map((r) => r.role), ["coordinator_phase", "reviewer_unit", "judge_round", "fixer_pass", "watch_cycle"]);
  });

  test("watch_cycle is honestly unavailable on provider tokens even on the claude (available-profile) harness — no model turn occurred", () => {
    const [, , , , watchCycleRecord] = driveRun(FIXTURE.runs.before, FIXTURE.harness);
    assert.equal(watchCycleRecord.hasUnavailableProviderMetric, true);
    assert.equal(watchCycleRecord.providerTokens.input.available, false);
  });

  test("before/after delta report names measured deltas with NO fixed percentage-savings claim", () => {
    const before = aggregatePhase(driveRun(FIXTURE.runs.before, FIXTURE.harness));
    const after = aggregatePhase(driveRun(FIXTURE.runs.after, FIXTURE.harness));
    const report = buildDeltaReport(before, after);

    assert.equal(after.turns < before.turns, true, "the after run genuinely consumed fewer model turns in this fixture");
    assert.doesNotMatch(report, /%/, "the delta report must never state a fixed percentage-savings claim");
    assert.match(report, /delta/);
    assert.match(report, /excluded from the token sum, never zero-filled/);
  });

  test("re-running the same fixture input is byte-deterministic (same records, same aggregate)", () => {
    const first = aggregatePhase(driveRun(FIXTURE.runs.before, FIXTURE.harness));
    const second = aggregatePhase(driveRun(FIXTURE.runs.before, FIXTURE.harness));
    assert.deepEqual(first, second);
  });
});
