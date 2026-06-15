import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DebtSignalSchema } from "../src/debt/debt-signal.mjs";

const validUUID = "550e8400-e29b-41d4-a716-446655440000";
const validTimestamp = "2024-06-03T12:00:00Z";

describe("debt-signal schema", () => {
  test("full valid shape parses successfully", () => {
    const input = {
      id: validUUID,
      sourceType: "ci_failure",
      signalKind: "flaky-test",
      location: {
        filePath: "src/index.mjs",
        lineStart: 10,
        lineEnd: 20,
        commitSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b",
        url: "https://github.com/mfittko/dev-loops/blob/main/src/index.mjs",
      },
      severityHint: "high",
      timestamp: validTimestamp,
      rawPayload: { key: "value" },
      repository: { owner: "mfittko", name: "dev-loops" },
      confidence: 0.85,
    };
    const result = DebtSignalSchema.safeParse(input);
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.id, validUUID);
      assert.equal(result.data.confidence, 0.85);
      assert.deepEqual(result.data.rawPayload, { key: "value" });
      assert.deepEqual(result.data.repository, { owner: "mfittko", name: "dev-loops" });
    }
  });

  test("minimal valid shape parses successfully", () => {
    const input = {
      id: validUUID,
      sourceType: "manual_review",
      signalKind: "todo",
      location: {},
      severityHint: "low",
      timestamp: validTimestamp,
    };
    const result = DebtSignalSchema.safeParse(input);
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.confidence, 1);
      assert.equal(result.data.rawPayload, undefined);
      assert.equal(result.data.repository, undefined);
    }
  });

  test("rejects missing id", () => {
    const input = {
      sourceType: "ci_failure",
      signalKind: "x",
      location: {},
      severityHint: "medium",
      timestamp: validTimestamp,
    };
    assert.equal(DebtSignalSchema.safeParse(input).success, false);
  });

  test("rejects malformed id", () => {
    const input = {
      id: "not-a-uuid",
      sourceType: "ci_failure",
      signalKind: "x",
      location: {},
      severityHint: "medium",
      timestamp: validTimestamp,
    };
    assert.equal(DebtSignalSchema.safeParse(input).success, false);
  });

  test("rejects missing sourceType", () => {
    const input = {
      id: validUUID,
      signalKind: "x",
      location: {},
      severityHint: "medium",
      timestamp: validTimestamp,
    };
    assert.equal(DebtSignalSchema.safeParse(input).success, false);
  });

  test("rejects invalid sourceType", () => {
    const input = {
      id: validUUID,
      sourceType: "unknown_source",
      signalKind: "x",
      location: {},
      severityHint: "medium",
      timestamp: validTimestamp,
    };
    assert.equal(DebtSignalSchema.safeParse(input).success, false);
  });

  test("rejects missing signalKind", () => {
    const input = {
      id: validUUID,
      sourceType: "ci_failure",
      location: {},
      severityHint: "medium",
      timestamp: validTimestamp,
    };
    assert.equal(DebtSignalSchema.safeParse(input).success, false);
  });

  test("rejects empty signalKind", () => {
    const input = {
      id: validUUID,
      sourceType: "ci_failure",
      signalKind: "",
      location: {},
      severityHint: "medium",
      timestamp: validTimestamp,
    };
    assert.equal(DebtSignalSchema.safeParse(input).success, false);
  });

  test("rejects signalKind > 100 chars", () => {
    const input = {
      id: validUUID,
      sourceType: "ci_failure",
      signalKind: "x".repeat(101),
      location: {},
      severityHint: "medium",
      timestamp: validTimestamp,
    };
    assert.equal(DebtSignalSchema.safeParse(input).success, false);
  });

  test("rejects missing location", () => {
    const input = {
      id: validUUID,
      sourceType: "ci_failure",
      signalKind: "x",
      severityHint: "medium",
      timestamp: validTimestamp,
    };
    assert.equal(DebtSignalSchema.safeParse(input).success, false);
  });

  test("rejects malformed location.lineStart (non-positive int)", () => {
    const input = {
      id: validUUID,
      sourceType: "ci_failure",
      signalKind: "x",
      location: { lineStart: 0 },
      severityHint: "medium",
      timestamp: validTimestamp,
    };
    assert.equal(DebtSignalSchema.safeParse(input).success, false);
  });

  test("rejects malformed location.commitSha (does not match regex)", () => {
    const input = {
      id: validUUID,
      sourceType: "ci_failure",
      signalKind: "x",
      location: { commitSha: "zzzzzzz" },
      severityHint: "medium",
      timestamp: validTimestamp,
    };
    assert.equal(DebtSignalSchema.safeParse(input).success, false);
  });

  test("rejects invalid url in location", () => {
    const input = {
      id: validUUID,
      sourceType: "ci_failure",
      signalKind: "x",
      location: { url: "not-a-url" },
      severityHint: "medium",
      timestamp: validTimestamp,
    };
    assert.equal(DebtSignalSchema.safeParse(input).success, false);
  });

  test("rejects missing severityHint", () => {
    const input = {
      id: validUUID,
      sourceType: "ci_failure",
      signalKind: "x",
      location: {},
      timestamp: validTimestamp,
    };
    assert.equal(DebtSignalSchema.safeParse(input).success, false);
  });

  test("rejects invalid severityHint", () => {
    const input = {
      id: validUUID,
      sourceType: "ci_failure",
      signalKind: "x",
      location: {},
      severityHint: "urgent",
      timestamp: validTimestamp,
    };
    assert.equal(DebtSignalSchema.safeParse(input).success, false);
  });

  test("rejects missing timestamp", () => {
    const input = {
      id: validUUID,
      sourceType: "ci_failure",
      signalKind: "x",
      location: {},
      severityHint: "medium",
    };
    assert.equal(DebtSignalSchema.safeParse(input).success, false);
  });

  test("rejects malformed timestamp (non-ISO-8601)", () => {
    const input = {
      id: validUUID,
      sourceType: "ci_failure",
      signalKind: "x",
      location: {},
      severityHint: "medium",
      timestamp: "not-a-date",
    };
    assert.equal(DebtSignalSchema.safeParse(input).success, false);
  });

  test("rejects extra fields (strictObject enforcement)", () => {
    const input = {
      id: validUUID,
      sourceType: "ci_failure",
      signalKind: "x",
      location: {},
      severityHint: "medium",
      timestamp: validTimestamp,
      extra: "field",
    };
    assert.equal(DebtSignalSchema.safeParse(input).success, false);
  });

  test("rejects invalid confidence (outside 0..1)", () => {
    const input = {
      id: validUUID,
      sourceType: "ci_failure",
      signalKind: "x",
      location: {},
      severityHint: "medium",
      timestamp: validTimestamp,
      confidence: 1.5,
    };
    assert.equal(DebtSignalSchema.safeParse(input).success, false);
  });

  test("accepts optional fields omitted (rawPayload, repository, confidence uses default)", () => {
    const input = {
      id: validUUID,
      sourceType: "ci_failure",
      signalKind: "x",
      location: {},
      severityHint: "medium",
      timestamp: validTimestamp,
    };
    const result = DebtSignalSchema.parse(input);
    assert.equal(result.confidence, 1);
    assert.equal(result.rawPayload, undefined);
    assert.equal(result.repository, undefined);
  });

  test("accepts all optional fields present (boundary test)", () => {
    const input = {
      id: validUUID,
      sourceType: "ci_failure",
      signalKind: "x",
      location: {
        filePath: "a.mjs",
        lineStart: 1,
        lineEnd: 2,
        commitSha: "a1b2c3d",
        url: "https://example.com",
      },
      severityHint: "critical",
      timestamp: validTimestamp,
      rawPayload: { a: 1 },
      repository: { owner: "o", name: "r" },
      confidence: 0,
    };
    const result = DebtSignalSchema.parse(input);
    assert.equal(result.confidence, 0);
    assert.deepEqual(result.rawPayload, { a: 1 });
    assert.deepEqual(result.repository, { owner: "o", name: "r" });
  });
});
