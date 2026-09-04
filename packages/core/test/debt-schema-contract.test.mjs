import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import {
  RemediationItemSchema,
  DebtEpicSchema,
} from "../src/debt/debt-finding.mjs";

const validUUID = "550e8400-e29b-41d4-a716-446655440000";
const validTimestamp = "2024-06-03T12:00:00Z";

describe("RemediationItemSchema", () => {
  test("full valid remediation_item parses successfully", () => {
    const input = {
      kind: "remediation_item",
      findingId: validUUID,
      title: "Fix spaghetti in auth module",
      description: "Refactor conditional logic into separate strategies.",
      acceptanceCriteria: [
        "Extract auth strategies",
        "No regression in test suite",
      ],
      score: 85,
      primaryFilePath: "src/auth.mjs",
      filePaths: ["src/auth.mjs", "src/auth-helper.mjs"],
      signalIds: [validUUID, "6ba7b810-9dad-11d1-80b4-00c04fd430c8"],
      sourceType: "debt_pipeline",
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    const result = RemediationItemSchema.safeParse(input);
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.kind, "remediation_item");
      assert.equal(result.data.score, 85);
      assert.equal(result.data.acceptanceCriteria.length, 2);
    }
  });

  test("minimal valid remediation_item parses successfully", () => {
    const input = {
      kind: "remediation_item",
      findingId: validUUID,
      title: "Fix thing",
      description: "Fix it.",
      acceptanceCriteria: ["It works"],
      filePaths: ["src/x.mjs"],
      score: 50,
      signalIds: [validUUID],
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    assert.equal(RemediationItemSchema.safeParse(input).success, true);
  });

  test("rejects wrong kind", () => {
    const input = {
      kind: "debt_epic",
      findingId: validUUID,
      title: "x",
      description: "x",
      acceptanceCriteria: ["x"],
      filePaths: ["src/x.mjs"],
      score: 50,
      signalIds: [validUUID],
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    assert.equal(RemediationItemSchema.safeParse(input).success, false);
  });

  test("rejects missing acceptanceCriteria", () => {
    const input = {
      kind: "remediation_item",
      findingId: validUUID,
      title: "x",
      description: "x",
      filePaths: ["src/x.mjs"],
      score: 50,
      signalIds: [validUUID],
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    assert.equal(RemediationItemSchema.safeParse(input).success, false);
  });

  test("rejects empty acceptanceCriteria array", () => {
    const input = {
      kind: "remediation_item",
      findingId: validUUID,
      title: "x",
      description: "x",
      acceptanceCriteria: [],
      filePaths: ["src/x.mjs"],
      score: 50,
      signalIds: [validUUID],
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    assert.equal(RemediationItemSchema.safeParse(input).success, false);
  });

  test("rejects missing filePaths", () => {
    const input = {
      kind: "remediation_item",
      findingId: validUUID,
      title: "x",
      description: "x",
      acceptanceCriteria: ["x"],
      score: 50,
      signalIds: [validUUID],
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    assert.equal(RemediationItemSchema.safeParse(input).success, false);
  });

  test("rejects extra fields", () => {
    const input = {
      kind: "remediation_item",
      findingId: validUUID,
      title: "x",
      description: "x",
      acceptanceCriteria: ["x"],
      filePaths: ["src/x.mjs"],
      score: 50,
      signalIds: [validUUID],
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
      extra: "nope",
    };
    assert.equal(RemediationItemSchema.safeParse(input).success, false);
  });
});

describe("DebtEpicSchema", () => {
  test("full valid debt_epic parses successfully", () => {
    const input = {
      kind: "debt_epic",
      findingId: validUUID,
      title: "Cross-cutting debt cleanup",
      description: "Multiple modules need refactoring.",
      score: 92,
      filePaths: ["src/a.mjs", "src/b.mjs"],
      signalIds: [validUUID, "6ba7b810-9dad-11d1-80b4-00c04fd430c8"],
      estimatedItems: 4,
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    const result = DebtEpicSchema.safeParse(input);
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.kind, "debt_epic");
      assert.equal(result.data.estimatedItems, 4);
    }
  });

  test("minimal valid debt_epic parses successfully", () => {
    const input = {
      kind: "debt_epic",
      findingId: validUUID,
      title: "Epic",
      description: "Do it.",
      filePaths: ["src/y.mjs"],
      score: 80,
      estimatedItems: 1,
      signalIds: [validUUID],
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    assert.equal(DebtEpicSchema.safeParse(input).success, true);
  });

  test("rejects wrong kind", () => {
    const input = {
      kind: "remediation_item",
      findingId: validUUID,
      title: "x",
      description: "x",
      filePaths: ["src/y.mjs"],
      score: 80,
      estimatedItems: 1,
      signalIds: [validUUID],
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    assert.equal(DebtEpicSchema.safeParse(input).success, false);
  });

  test("rejects missing estimatedItems", () => {
    const input = {
      kind: "debt_epic",
      findingId: validUUID,
      title: "x",
      description: "x",
      filePaths: ["src/y.mjs"],
      score: 80,
      signalIds: [validUUID],
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    assert.equal(DebtEpicSchema.safeParse(input).success, false);
  });

  test("rejects estimatedItems zero", () => {
    const input = {
      kind: "debt_epic",
      findingId: validUUID,
      title: "x",
      description: "x",
      filePaths: ["src/y.mjs"],
      score: 80,
      signalIds: [validUUID],
      estimatedItems: 0,
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
    };
    assert.equal(DebtEpicSchema.safeParse(input).success, false);
  });

  test("rejects extra fields", () => {
    const input = {
      kind: "debt_epic",
      findingId: validUUID,
      title: "x",
      description: "x",
      filePaths: ["src/y.mjs"],
      score: 80,
      estimatedItems: 1,
      signalIds: [validUUID],
      createdAt: validTimestamp,
      updatedAt: validTimestamp,
      extra: "nope",
    };
    assert.equal(DebtEpicSchema.safeParse(input).success, false);
  });
});
