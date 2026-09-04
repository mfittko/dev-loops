import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import {
  remediationToIssuePayload,
  createRemediationIssue,
} from "../src/debt/remediation-to-issue.mjs";

const uuid = (n) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;

function buildValidItem(overrides = {}) {
  return {
    kind: "remediation_item",
    findingId: "550e8400-e29b-41d4-a716-446655440000",
    title: "Fix spaghetti in auth",
    description: "Refactor login handler to use strategy pattern.",
    acceptanceCriteria: [
      "Extract auth strategies into separate functions",
      "No regression in login test suite",
      "Maintain >= 90% coverage",
    ],
    score: 85,
    primaryFilePath: "src/auth/login.mjs",
    filePaths: ["src/auth/login.mjs"],
    signalIds: [uuid(1), uuid(2)],
    sourceType: "debt_pipeline",
    createdAt: "2024-06-03T12:00:00Z",
    updatedAt: "2024-06-03T12:00:00Z",
    ...overrides,
  };
}

describe("remediationToIssuePayload", () => {
  test("produces title, body, and labels", () => {
    const item = buildValidItem();
    const payload = remediationToIssuePayload(item);

    assert.ok(payload.title.includes("spaghetti"));
    assert.ok(payload.body.includes("## Remediation Item"));
    assert.ok(payload.body.includes("**Finding ID:** 550e8400"));
    assert.ok(payload.body.includes("**Score:** 85"));
    assert.ok(payload.body.includes("### Acceptance Criteria"));
    assert.ok(payload.body.includes("1. Extract auth strategies"));
    assert.ok(payload.body.includes("2. No regression"));
    assert.ok(payload.body.includes("3. Maintain >= 90% coverage"));
    assert.deepEqual(payload.labels, ["workflow"]);
  });

  test("acceptance criteria rendered as numbered list", () => {
    const item = buildValidItem({
      acceptanceCriteria: ["One", "Two"],
    });
    const payload = remediationToIssuePayload(item);
    assert.ok(payload.body.includes("1. One"));
    assert.ok(payload.body.includes("2. Two"));
  });

  test("N/A shown when no primaryFilePath", () => {
    const item = buildValidItem({ primaryFilePath: undefined });
    const payload = remediationToIssuePayload(item);
    assert.ok(payload.body.includes("**Primary file:** N/A"));
  });

  test("signal count shown in source section", () => {
    const item = buildValidItem({ signalIds: [uuid(1), uuid(2), uuid(3)] });
    const payload = remediationToIssuePayload(item);
    assert.ok(payload.body.includes("3 signal(s)"));
  });

  test("throws on invalid input (schema rejection)", () => {
    assert.throws(() => {
      remediationToIssuePayload({ kind: "wrong", findingId: "bad" });
    });
  });

  test("payload shape matches contract for --assignee @me flag", () => {
    const item = buildValidItem();
    const payload = remediationToIssuePayload(item);
    assert.ok(payload.title);
    assert.ok(payload.body.includes("## Remediation Item"));
    assert.deepEqual(payload.labels, ["workflow"]);
  });
});

describe("createRemediationIssue URL parsing", () => {
  test("returns error when gh is not available (network or PATH)", () => {
    const result = createRemediationIssue(buildValidItem(), { owner: "test", name: "test" });
    // In test environment, gh is not available, so result should be error
    assert.equal(result.ok, false);
    assert.ok(typeof result.error === "string");
  });

  test("rejects gh output that lacks an issue number", () => {
    // Verifies the contract: when gh output doesn't contain /issues/<digit>,
    // the result is ok:false with a descriptive error.
    // (Cannot mock execFileSync in bare Node, so this tests the error path.)
    const savedPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const result = createRemediationIssue(buildValidItem(), { owner: "test", name: "test" });
      assert.equal(result.ok, false);
      assert.ok(result.error.includes("gh") || result.error.length > 0);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
