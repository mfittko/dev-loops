import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { clusterSignalsEnriched } from "../src/debt/cluster.mjs";
import { shapeFinding } from "../src/debt/shape.mjs";

// Synthetic deep-persona-style signals simulating a real PR review output
function syntheticSignal(id, opts = {}) {
  return {
    id,
    sourceType: "pr_review_deep_persona",
    signalKind: opts.signalKind || "file_size",
    location: opts.location || {},
    severityHint: opts.severityHint || "high",
    timestamp: "2024-06-03T12:00:00Z",
    confidence: opts.confidence ?? 0.9,
    rawPayload: {
      description: opts.description || "Auto-generated synthetic signal",
      metadata: {
        prNumber: "88",
        prUrl: "https://github.com/mfittko/dev-loops/pull/88",
        commentId: `comment-${id}`,
        category: opts.signalKind || "file_size",
      },
    },
  };
}

const uuid = (n) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;

describe("debt e2e synthetic", () => {
  test("synthetic deep-persona signals → finding → remediation_item", () => {
    // Create signals simulating a real review with spaghetti issues in auth module
    const signals = [
      syntheticSignal(uuid(1), {
        signalKind: "spaghetti_branching",
        severityHint: "high",
        location: { filePath: "src/auth/login.mjs" },
        description: "Spaghetti logic in login handler",
      }),
      syntheticSignal(uuid(2), {
        signalKind: "spaghetti_branching",
        severityHint: "high",
        location: { filePath: "src/auth/login.mjs" },
        description: "Conditionals bolted onto unrelated paths in login",
      }),
      syntheticSignal(uuid(3), {
        signalKind: "weak_contract",
        severityHint: "medium",
        location: { filePath: "src/auth/login.mjs" },
        description: "Cast-heavy validation in login",
      }),
    ];

    // Step 1: cluster
    const findings = clusterSignalsEnriched(signals);
    assert.ok(findings.length >= 1, "should produce at least one finding");
    assert.equal(findings[0].signalIds.length, 3, "all 3 signals share same file");

    // Step 2: the finding should have a score
    const finding = findings[0];
    assert.ok(finding.score >= 50, `score=${finding.score} should be substantial`);
    assert.ok(finding.score <= 100);

    // Step 3: shape
    const { outcome, artifact } = shapeFinding(finding);

    // With 3 signals at high severity, should be remediation_item (not epic since _signalCount <= 3)
    // The EPIC_SIGNAL_COUNT_THRESHOLD is 3, so > 3 → epic; 3 → item
    assert.equal(outcome, "remediation_item");

    // Step 4: artifact structure
    assert.ok(artifact);
    assert.equal(artifact.kind, "remediation_item");
    assert.ok(artifact.title.includes("spaghetti_branching") || artifact.title.includes("auth"));
    assert.ok(Array.isArray(artifact.acceptanceCriteria));
    assert.ok(artifact.acceptanceCriteria.length >= 1);
    assert.ok(Array.isArray(artifact.signalIds));
    assert.equal(artifact.signalIds.length, 3);
    assert.equal(artifact.primaryFilePath, "src/auth/login.mjs");
  });

  test("multi-file deep signals cluster and produce debt_epic", () => {
    const signals = [
      syntheticSignal(uuid(1), {
        signalKind: "spaghetti_branching", severityHint: "high",
        location: { filePath: "src/auth/login.mjs" },
      }),
      syntheticSignal(uuid(2), {
        signalKind: "spaghetti_branching", severityHint: "high",
        location: { filePath: "src/auth/logout.mjs" },
      }),
      syntheticSignal(uuid(3), {
        signalKind: "spaghetti_branching", severityHint: "high",
        location: { filePath: "src/auth/session.mjs" },
      }),
      syntheticSignal(uuid(4), {
        signalKind: "spaghetti_branching", severityHint: "critical",
        location: { filePath: "src/auth/token.mjs" },
      }),
    ];

    const findings = clusterSignalsEnriched(signals);
    // All in src/auth but different files → module cluster with 4 signals
    assert.equal(findings.length, 1);
    assert.equal(findings[0].signalIds.length, 4);

    const { outcome, artifact } = shapeFinding(findings[0]);
    assert.equal(outcome, "debt_epic");
    assert.ok(artifact);
    assert.equal(artifact.kind, "debt_epic");
    assert.ok(artifact.estimatedItems >= 2);
  });

  test("single orphan low-severity signal → dismiss", () => {
    const signals = [
      syntheticSignal(uuid(1), {
        signalKind: "thin_wrapper",
        severityHint: "info",
        confidence: 0.5,
        location: {},
        description: "Minor thin wrapper note",
      }),
    ];

    const findings = clusterSignalsEnriched(signals);
    assert.equal(findings.length, 1);

    const { outcome, artifact } = shapeFinding(findings[0]);
    // Low severity info signal should score low → dismiss
    assert.equal(outcome, "dismiss");
  });
});
