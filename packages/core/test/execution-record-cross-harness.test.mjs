import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import { buildExecutionUnitRecord, TELEMETRY_HARNESS_PROFILES } from "../src/loop/execution-record.mjs";
import { HARNESS_VALUES } from "../src/loop/role-budget-bound.mjs";
import { buildWatchCycleExecutionRecord } from "../../../scripts/loop/run-watch-cycle.mjs";

const HEAD_SHA = "c".repeat(40);
const HARNESSES = HARNESS_VALUES; // ["pi", "claude", "codex"]

/**
 * Cross-harness regression coverage for the execution-record telemetry seam
 * (issue 2157 slice b2, AC4). Modeled on spec-authority-cross-harness.test.mjs's
 * parameterize-over-every-harness shape. This is the internal fail-closed test
 * the b1 retro flagged as missing: a harness that cannot observe provider-token
 * telemetry must throw the moment it is handed a numeric value, not silently
 * report it — this guard must be caught HERE, not by an external reviewer.
 */
describe("execution-record cross-harness parity (Pi / Claude Code / Codex, issue 2157 AC4)", () => {
  test("TELEMETRY_HARNESS_PROFILES covers exactly the 3 dev-loop harnesses", () => {
    assert.deepEqual(Object.keys(TELEMETRY_HARNESS_PROFILES).sort(), [...HARNESSES].sort());
  });

  test("claude measures a real provider-token value; pi and codex record it as unavailable-with-reason", () => {
    for (const harness of HARNESSES) {
      const record = buildExecutionUnitRecord({
        harness,
        role: "coordinator_phase",
        identity: { headSha: HEAD_SHA, phase: "draft_gate" },
        promptBytes: 100, contextBytes: 50, turns: 2, toolCalls: 3,
        providerTokens: { input: null, output: null, cacheRead: null },
        localToolTimeMs: 10,
        childWallTimeMs: 500,
        outcome: "ok",
      });
      if (harness === "claude") {
        // claude's profile is observable, but a null input still honestly
        // records unavailable-for-this-call — the fixture below proves the
        // MEASURED path separately.
        assert.equal(record.providerTokens.input.available, false);
        assert.match(record.providerTokens.input.reason, /no value was reported/);
      } else {
        assert.equal(record.providerTokens.input.available, false);
        assert.match(record.providerTokens.input.reason, /does not expose provider token usage telemetry/);
      }
    }
  });

  test("claude records a MEASURED provider-token value when a real value is supplied", () => {
    const record = buildExecutionUnitRecord({
      harness: "claude",
      role: "judge_round",
      identity: { headSha: HEAD_SHA, round: 1 },
      promptBytes: 100, contextBytes: 50, turns: 2, toolCalls: 3,
      providerTokens: { input: 500, output: 300, cacheRead: 50 },
      localToolTimeMs: 10,
      childWallTimeMs: 500,
      outcome: "ok",
    });
    assert.equal(record.providerTokens.input.available, true);
    assert.equal(record.providerTokens.input.value, 500);
    assert.equal(record.hasUnavailableProviderMetric, false);
  });

  test("FAIL CLOSED: pi and codex must never report a numeric provider-token value — they throw the moment a value is supplied", () => {
    for (const harness of ["pi", "codex"]) {
      assert.throws(
        () => buildExecutionUnitRecord({
          harness,
          role: "judge_round",
          identity: { headSha: HEAD_SHA, round: 1 },
          promptBytes: 100, contextBytes: 50, turns: 2, toolCalls: 3,
          providerTokens: { input: 500, output: null, cacheRead: null },
          localToolTimeMs: 10,
          childWallTimeMs: null,
          outcome: "ok",
        }),
        /does not expose provider token usage telemetry/,
        `${harness} must fail closed on a numeric providerTokens.input`,
      );
    }
  });

  test("watch_cycle is harness-agnostic: identical local-metric shape and unavailable-provider-tokens across every harness", () => {
    const records = HARNESSES.map((harness) => buildWatchCycleExecutionRecord({
      owner: { runId: "run-x" },
      cycleDisposition: "pending",
      headSha: HEAD_SHA,
      harness,
      toolCalls: 2,
      localToolTimeMs: 40,
    }));
    const [first, ...rest] = records;
    for (const record of rest) {
      assert.deepEqual(record.metrics, first.metrics, "local metrics must be identical regardless of harness");
      assert.equal(record.hasUnavailableProviderMetric, true);
      assert.equal(record.providerTokens.input.available, false);
      assert.equal(record.providerTokens.input.reason, first.providerTokens.input.reason, "the no-model-turn reason is harness-independent");
    }
    // Only `harness` itself differs across the three records.
    for (const [i, harness] of HARNESSES.entries()) {
      assert.equal(records[i].harness, harness);
    }
  });

  test("exercises the real run-watch-cycle producer seam per harness", () => {
    for (const harness of HARNESSES) {
      const record = buildWatchCycleExecutionRecord({
        owner: null,
        cycleDisposition: "terminal",
        headSha: HEAD_SHA,
        harness,
        toolCalls: 0,
        localToolTimeMs: 0,
      });
      assert.equal(record.role, "watch_cycle");
      assert.equal(record.waitOwner, null);
      assert.equal(record.outcome, "terminal");
      assert.equal(record.metrics.turns, 0, "a watch cycle performs no model turn — a genuine measured zero");
    }
  });
});
