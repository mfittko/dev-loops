import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import { DebtFindingSchema } from "../src/debt/debt-finding.mjs";

const validUUID = "550e8400-e29b-41d4-a716-446655440000";
const validTimestamp = "2024-06-03T12:00:00Z";

describe("debt-finding schema", () => {
  test("full valid shape parses successfully", () => {
    const input = {
      id: validUUID,
      signalIds: [validUUID, "6ba7b810-9dad-11d1-80b4-00c04fd430c8"],
      validationStatus: "validated",
      score: 75,
      remediationShape: "item",
      title: "Fix flaky test in core",
      description: "The test fails intermittently due to race condition.",
      locationSummary: {
        filePaths: ["src/test.mjs"],
        primaryFilePath: "src/test.mjs",
      },
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    const result = DebtFindingSchema.safeParse(input);
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.id, validUUID);
      assert.equal(result.data.score, 75);
      assert.equal(result.data.description, "The test fails intermittently due to race condition.");
      assert.deepEqual(result.data.locationSummary, {
        filePaths: ["src/test.mjs"],
        primaryFilePath: "src/test.mjs",
      });
    }
  });

  test("minimal valid shape parses successfully", () => {
    const input = {
      id: validUUID,
      signalIds: [validUUID],
      validationStatus: "pending",
      remediationShape: "watch_only",
      title: "Watch memory usage",
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    const result = DebtFindingSchema.safeParse(input);
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.score, undefined);
      assert.equal(result.data.description, undefined);
      assert.equal(result.data.locationSummary, undefined);
    }
  });

  test("rejects missing id", () => {
    const input = {
      signalIds: [validUUID],
      validationStatus: "pending",
      remediationShape: "item",
      title: "x",
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    assert.equal(DebtFindingSchema.safeParse(input).success, false);
  });

  test("rejects malformed id", () => {
    const input = {
      id: "bad-id",
      signalIds: [validUUID],
      validationStatus: "pending",
      remediationShape: "item",
      title: "x",
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    assert.equal(DebtFindingSchema.safeParse(input).success, false);
  });

  test("rejects missing signalIds", () => {
    const input = {
      id: validUUID,
      validationStatus: "pending",
      remediationShape: "item",
      title: "x",
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    assert.equal(DebtFindingSchema.safeParse(input).success, false);
  });

  test("rejects empty signalIds array", () => {
    const input = {
      id: validUUID,
      signalIds: [],
      validationStatus: "pending",
      remediationShape: "item",
      title: "x",
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    assert.equal(DebtFindingSchema.safeParse(input).success, false);
  });

  test("rejects non-UUID in signalIds", () => {
    const input = {
      id: validUUID,
      signalIds: ["not-a-uuid"],
      validationStatus: "pending",
      remediationShape: "item",
      title: "x",
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    assert.equal(DebtFindingSchema.safeParse(input).success, false);
  });

  test("rejects missing validationStatus", () => {
    const input = {
      id: validUUID,
      signalIds: [validUUID],
      remediationShape: "item",
      title: "x",
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    assert.equal(DebtFindingSchema.safeParse(input).success, false);
  });

  test("rejects invalid validationStatus", () => {
    const input = {
      id: validUUID,
      signalIds: [validUUID],
      validationStatus: "unknown",
      remediationShape: "item",
      title: "x",
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    assert.equal(DebtFindingSchema.safeParse(input).success, false);
  });

  test("rejects invalid score (negative, > 100, non-number)", () => {
    const base = {
      id: validUUID,
      signalIds: [validUUID],
      validationStatus: "pending",
      remediationShape: "item",
      title: "x",
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    assert.equal(DebtFindingSchema.safeParse({ ...base, score: -1 }).success, false);
    assert.equal(DebtFindingSchema.safeParse({ ...base, score: 101 }).success, false);
    assert.equal(DebtFindingSchema.safeParse({ ...base, score: "abc" }).success, false);
  });

  test("rejects missing remediationShape", () => {
    const input = {
      id: validUUID,
      signalIds: [validUUID],
      validationStatus: "pending",
      title: "x",
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    assert.equal(DebtFindingSchema.safeParse(input).success, false);
  });

  test("rejects invalid remediationShape", () => {
    const input = {
      id: validUUID,
      signalIds: [validUUID],
      validationStatus: "pending",
      remediationShape: "unknown",
      title: "x",
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    assert.equal(DebtFindingSchema.safeParse(input).success, false);
  });

  test("rejects missing title", () => {
    const input = {
      id: validUUID,
      signalIds: [validUUID],
      validationStatus: "pending",
      remediationShape: "item",
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    assert.equal(DebtFindingSchema.safeParse(input).success, false);
  });

  test("rejects empty title", () => {
    const input = {
      id: validUUID,
      signalIds: [validUUID],
      validationStatus: "pending",
      remediationShape: "item",
      title: "",
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    assert.equal(DebtFindingSchema.safeParse(input).success, false);
  });

  test("rejects title > 200 chars", () => {
    const input = {
      id: validUUID,
      signalIds: [validUUID],
      validationStatus: "pending",
      remediationShape: "item",
      title: "x".repeat(201),
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    assert.equal(DebtFindingSchema.safeParse(input).success, false);
  });

  test("rejects missing createdAt", () => {
    const input = {
      id: validUUID,
      signalIds: [validUUID],
      validationStatus: "pending",
      remediationShape: "item",
      title: "x",
      updatedAt: validTimestamp,
    };
    assert.equal(DebtFindingSchema.safeParse(input).success, false);
  });

  test("rejects missing updatedAt", () => {
    const input = {
      id: validUUID,
      signalIds: [validUUID],
      validationStatus: "pending",
      remediationShape: "item",
      title: "x",
      createdAt: validTimestamp,
    };
    assert.equal(DebtFindingSchema.safeParse(input).success, false);
  });

  test("rejects extra fields (strictObject enforcement)", () => {
    const input = {
      id: validUUID,
      signalIds: [validUUID],
      validationStatus: "pending",
      remediationShape: "item",
      title: "x",
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
      extra: "field",
    };
    assert.equal(DebtFindingSchema.safeParse(input).success, false);
  });

  test("accepts optional fields omitted (score, description, locationSummary)", () => {
    const input = {
      id: validUUID,
      signalIds: [validUUID],
      validationStatus: "pending",
      remediationShape: "item",
      title: "x",
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    const result = DebtFindingSchema.parse(input);
    assert.equal(result.score, undefined);
    assert.equal(result.description, undefined);
    assert.equal(result.locationSummary, undefined);
  });

  test("accepts all optional fields present (boundary test)", () => {
    const input = {
      id: validUUID,
      signalIds: [validUUID],
      validationStatus: "validated",
      score: 100,
      remediationShape: "epic",
      title: "y",
      description: "desc",
      locationSummary: {
        filePaths: ["a.mjs"],
        primaryFilePath: "a.mjs",
      },
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    const result = DebtFindingSchema.parse(input);
    assert.equal(result.score, 100);
    assert.equal(result.description, "desc");
    assert.deepEqual(result.locationSummary, {
      filePaths: ["a.mjs"],
      primaryFilePath: "a.mjs",
    });
  });
});
