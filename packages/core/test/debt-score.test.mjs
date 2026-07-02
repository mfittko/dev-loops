import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { scoreCluster, SCORE_WEIGHTS } from "../src/debt/score.mjs";

// Helper: create a synthetic signal with given severity and optional properties
function sig(severityHint, opts = {}) {
  return {
    id: opts.id || "550e8400-e29b-41d4-a716-446655440000",
    sourceType: "pr_review_deep_persona",
    signalKind: opts.signalKind || "file_size",
    location: opts.location || {},
    severityHint,
    timestamp: "2024-06-03T12:00:00Z",
    confidence: opts.confidence ?? 1,
  };
}

describe("debt-score model", () => {
  describe("determinism", () => {
    test("same inputs → same score", () => {
      const signals = [sig("high"), sig("medium"), sig("low")];
      const a = scoreCluster(signals);
      const b = scoreCluster(signals);
      assert.equal(a, b);
    });

    test("different order → same score", () => {
      const a = scoreCluster([sig("high"), sig("low")]);
      const b = scoreCluster([sig("low"), sig("high")]);
      assert.equal(a, b);
    });
  });

  describe("monotonicity", () => {
    test("more signals → higher or equal score", () => {
      const one = scoreCluster([sig("medium")]);
      const two = scoreCluster([sig("medium"), sig("medium")]);
      assert.ok(two >= one, `two=${two} >= one=${one}`);
    });

    test("higher severity → higher or equal score", () => {
      const low = scoreCluster([sig("low")]);
      const high = scoreCluster([sig("high")]);
      assert.ok(high >= low, `high=${high} >= low=${low}`);
    });

    test("adding a signal never decreases score", () => {
      const before = scoreCluster([sig("medium"), sig("medium")]);
      const after = scoreCluster([sig("medium"), sig("medium"), sig("medium")]);
      assert.ok(after >= before);
    });
  });

  describe("boundary handling", () => {
    test("zero inputs → 0", () => {
      assert.equal(scoreCluster([]), 0);
    });

    test("single-signal cluster returns a score", () => {
      const s = scoreCluster([sig("critical")]);
      assert.ok(s > 0);
      assert.ok(s <= 100);
    });

    test("large cluster does not exceed 100", () => {
      const signals = Array.from({ length: 100 }, (_, i) =>
        sig("critical", { id: `uuid-${i}-xxxx-xxxx-xxxxxxxxxxxx`.replace(/[^a-f0-9-]/g, "0") })
      );
      const s = scoreCluster(signals);
      assert.ok(s >= 0 && s <= 100, `score=${s}`);
    });

    test("non-array input → 0", () => {
      assert.equal(scoreCluster(null), 0);
      assert.equal(scoreCluster(undefined), 0);
    });
  });

  describe("score range", () => {
    test("all scores in 0-100 range", () => {
      const tests = [
        [sig("info")],
        [sig("low")],
        [sig("medium")],
        [sig("high")],
        [sig("critical")],
        [sig("info"), sig("info")],
        [sig("critical"), sig("critical"), sig("critical")],
      ];
      for (const signals of tests) {
        const s = scoreCluster(signals);
        assert.ok(s >= 0 && s <= 100, `score=${s} for ${signals.length} signals`);
      }
    });
  });

  describe("weights are exported", () => {
    test("SCORE_WEIGHTS sum to 1", () => {
      const sum = SCORE_WEIGHTS.frequency + SCORE_WEIGHTS.severity + SCORE_WEIGHTS.impact;
      assert.ok(Math.abs(sum - 1) < 0.001, `weights sum to ${sum}`);
    });

    test("weights are frozen", () => {
      assert.throws(() => { SCORE_WEIGHTS.frequency = 0.5; }, TypeError);
    });
  });

  describe("impact heuristics", () => {
    test("signals with file paths score higher", () => {
      const without = scoreCluster([sig("medium")]);
      const withFile = scoreCluster([sig("medium", { location: { filePath: "src/x.mjs" } })]);
      assert.ok(withFile >= without, `withFile=${withFile} >= without=${without}`);
    });

    test("higher confidence boosts score", () => {
      const lowConf = scoreCluster([sig("medium", { confidence: 0.3 })]);
      const highConf = scoreCluster([sig("medium", { confidence: 1.0 })]);
      assert.ok(highConf >= lowConf, `highConf=${highConf} >= lowConf=${lowConf}`);
    });

    test("diverse signalKinds boost score", () => {
      const same = scoreCluster([sig("medium", { signalKind: "file_size" }), sig("medium", { signalKind: "file_size" })]);
      const diverse = scoreCluster([sig("medium", { signalKind: "file_size" }), sig("medium", { signalKind: "spaghetti_branching" })]);
      assert.ok(diverse >= same, `diverse=${diverse} >= same=${same}`);
    });
  });
});
