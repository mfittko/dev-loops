import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import { shapeFinding, shapeFindings, ITEM_THRESHOLD, DEFER_THRESHOLD, WATCH_THRESHOLD, EPIC_SIGNAL_COUNT_THRESHOLD } from "../src/debt/shape.mjs";
const uuid = (n) => '00000000-0000-4000-a000-' + String(n).padStart(12, '0');

// Helper: build an enriched finding shape
function finding(opts = {}) {
  return {
    id: opts.id || "550e8400-e29b-41d4-a716-446655440000",
    signalIds: opts.signalIds || ["00000000-0000-4000-a000-000000000001"],
    validationStatus: "pending",
    score: opts.score ?? 0,
    remediationShape: "watch_only",
    title: opts.title || "Test finding",
    description: opts.description || "Test description",
    locationSummary: opts.locationSummary || { filePaths: ["src/default.mjs"], primaryFilePath: "src/default.mjs" },
    createdAt: "2024-06-03T12:00:00Z",
    updatedAt: "2024-06-03T12:00:00Z",
    _clusterReason: opts._clusterReason || "theme",
    _signalCount: opts._signalCount ?? opts.signalIds?.length ?? 1,
  };
}

describe("debt-shape", () => {
  describe("remediation_item outcome", () => {
    test("high score + few signals → remediation_item", () => {
      const f = finding({ score: 85, signalIds: [uuid(1), uuid(2)] });
      const { outcome, artifact } = shapeFinding(f);
      assert.equal(outcome, "remediation_item");
      assert.ok(artifact);
      assert.equal(artifact.kind, "remediation_item");
      assert.equal(artifact.findingId, f.id);
      assert.ok(artifact.acceptanceCriteria.length >= 1);
    });

    test("score at ITEM_THRESHOLD boundary → remediation_item", () => {
      const f = finding({ score: ITEM_THRESHOLD, signalIds: [uuid(1)] });
      const { outcome } = shapeFinding(f);
      assert.equal(outcome, "remediation_item");
    });

    test("remediation_item has required fields", () => {
      const f = finding({ score: 90, locationSummary: { filePaths: ["src/a.mjs"], primaryFilePath: "src/a.mjs" } });
      const { artifact } = shapeFinding(f);
      assert.ok(artifact);
      assert.equal(artifact.kind, "remediation_item");
      assert.ok(artifact.title);
      assert.ok(artifact.description);
      assert.ok(Array.isArray(artifact.acceptanceCriteria));
      assert.ok(artifact.acceptanceCriteria.length > 0);
      assert.ok(Array.isArray(artifact.signalIds));
      assert.ok(artifact.signalIds.length > 0);
      assert.equal(artifact.primaryFilePath, "src/a.mjs");
    });
  });

  describe("debt_epic outcome", () => {
    test("high score + many signals → debt_epic", () => {
      const f = finding({
        score: 88,
        signalIds: [uuid(1), uuid(2), uuid(3), uuid(4)],
        _signalCount: 4,
      });
      const { outcome, artifact } = shapeFinding(f);
      assert.equal(outcome, "debt_epic");
      assert.ok(artifact);
      assert.equal(artifact.kind, "debt_epic");
      assert.ok(artifact.estimatedItems >= 1);
    });

    test("debt_epic has required fields", () => {
      const f = finding({
        score: 92,
        signalIds: [uuid(1), uuid(2), uuid(3), uuid(4)],
        _signalCount: 4,
        locationSummary: { filePaths: ["src/a.mjs", "src/b.mjs"] },
      });
      const { artifact } = shapeFinding(f);
      assert.ok(artifact);
      assert.equal(artifact.kind, "debt_epic");
      assert.equal(artifact.score, 92);
      assert.deepEqual(artifact.filePaths, ["src/a.mjs", "src/b.mjs"]);
      assert.ok(artifact.estimatedItems >= 1);
    });
  });

  describe("defer outcome", () => {
    test("medium score → defer", () => {
      const f = finding({ score: 60 });
      const { outcome, artifact } = shapeFinding(f);
      assert.equal(outcome, "defer");
      assert.equal(artifact, null);
    });

    test("score at DEFER_THRESHOLD boundary → defer", () => {
      const f = finding({ score: DEFER_THRESHOLD });
      const { outcome } = shapeFinding(f);
      assert.equal(outcome, "defer");
    });

    test("score just below ITEM_THRESHOLD → defer", () => {
      const f = finding({ score: ITEM_THRESHOLD - 1 });
      const { outcome } = shapeFinding(f);
      assert.equal(outcome, "defer");
    });
  });

  describe("watch outcome", () => {
    test("low score → watch", () => {
      const f = finding({ score: 40 });
      const { outcome, artifact } = shapeFinding(f);
      assert.equal(outcome, "watch");
      assert.equal(artifact, null);
    });

    test("score at WATCH_THRESHOLD boundary → watch", () => {
      const f = finding({ score: WATCH_THRESHOLD });
      const { outcome } = shapeFinding(f);
      assert.equal(outcome, "watch");
    });

    test("score just below DEFER_THRESHOLD → watch", () => {
      const f = finding({ score: DEFER_THRESHOLD - 1 });
      const { outcome } = shapeFinding(f);
      assert.equal(outcome, "watch");
    });
  });

  describe("dismiss outcome", () => {
    test("very low score → dismiss", () => {
      const f = finding({ score: 10 });
      const { outcome, artifact } = shapeFinding(f);
      assert.equal(outcome, "dismiss");
      assert.equal(artifact, null);
    });

    test("zero score → dismiss", () => {
      const f = finding({ score: 0 });
      const { outcome } = shapeFinding(f);
      assert.equal(outcome, "dismiss");
    });
  });

  describe("all five outcomes", () => {
    test("shapeFindings covers all outcome branches", () => {
      const findings = [
        finding({ score: 90, signalIds: [uuid(1)], _signalCount: 1 }), // remediation_item
        finding({ score: 90, signalIds: [uuid(1), uuid(2), uuid(3), uuid(4)], _signalCount: 4 }), // debt_epic
        finding({ score: 60, signalIds: [uuid(5)] }), // defer
        finding({ score: 40, signalIds: [uuid(6)] }), // watch
        finding({ score: 10, signalIds: [uuid(7)] }), // dismiss
      ];
      const results = shapeFindings(findings);
      const outcomes = results.map(r => r.outcome);
      assert.deepEqual(outcomes, ["remediation_item", "debt_epic", "defer", "watch", "dismiss"]);
    });
  });

  describe("thresholds are exported", () => {
    test("ITEM_THRESHOLD, DEFER_THRESHOLD, WATCH_THRESHOLD, EPIC_SIGNAL_COUNT_THRESHOLD are numbers", () => {
      assert.ok(typeof ITEM_THRESHOLD === "number");
      assert.ok(typeof DEFER_THRESHOLD === "number");
      assert.ok(typeof WATCH_THRESHOLD === "number");
      assert.ok(typeof EPIC_SIGNAL_COUNT_THRESHOLD === "number");
    });
  });
});
