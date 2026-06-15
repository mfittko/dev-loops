import assert from "node:assert/strict";
import test from "node:test";

import {
  AcDodMatrixItemSchema,
  AcDodMatrixSchema,
  validateAcDodMatrix,
  isMatrixComplete,
  outstandingItems,
  AC_DOD_ITEM_TYPE,
  AC_DOD_ITEM_STATUS,
} from "../src/refinement/ac-dod-matrix.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validItem = Object.freeze({
  item: "Zod schema committed for the AC/DoD matrix output",
  type: AC_DOD_ITEM_TYPE.AC,
  status: AC_DOD_ITEM_STATUS.MET,
  evidence: "packages/core/src/refinement/ac-dod-matrix.mjs",
  notes: "Exported as ./refinement/ac-dod-matrix",
});

const validMatrix = Object.freeze({
  schema: "ac-dod-matrix/v1",
  items: [
    validItem,
    {
      item: "Refiner produces a valid structured JSON contract",
      type: AC_DOD_ITEM_TYPE.AC,
      status: AC_DOD_ITEM_STATUS.UNVERIFIED,
      evidence: "refiner output",
      notes: "Pending refiner integration",
    },
  ],
  source: "https://github.com/mfittko/dev-loops/issues/675",
  generatedAt: "2026-06-08T12:00:00.000Z",
  isComplete: false,
});

// ---------------------------------------------------------------------------
// AcDodMatrixItemSchema
// ---------------------------------------------------------------------------

test("AcDodMatrixItemSchema accepts valid item", () => {
  const result = AcDodMatrixItemSchema.safeParse(validItem);
  assert.equal(result.success, true);
});

test("AcDodMatrixItemSchema rejects missing item", () => {
  const { item, ...rest } = validItem;
  const result = AcDodMatrixItemSchema.safeParse(rest);
  assert.equal(result.success, false);
});

test("AcDodMatrixItemSchema rejects empty item string", () => {
  const result = AcDodMatrixItemSchema.safeParse({ ...validItem, item: "" });
  assert.equal(result.success, false);
});

test("AcDodMatrixItemSchema rejects invalid type", () => {
  const result = AcDodMatrixItemSchema.safeParse({ ...validItem, type: "invalid" });
  assert.equal(result.success, false);
});

test("AcDodMatrixItemSchema rejects invalid status", () => {
  const result = AcDodMatrixItemSchema.safeParse({ ...validItem, status: "done" });
  assert.equal(result.success, false);
});

test("AcDodMatrixItemSchema accepts all valid types", () => {
  for (const type of Object.values(AC_DOD_ITEM_TYPE)) {
    const result = AcDodMatrixItemSchema.safeParse({ ...validItem, type });
    assert.equal(result.success, true, `type ${type} should be valid`);
  }
});

test("AcDodMatrixItemSchema accepts all valid statuses", () => {
  for (const status of Object.values(AC_DOD_ITEM_STATUS)) {
    const result = AcDodMatrixItemSchema.safeParse({ ...validItem, status });
    assert.equal(result.success, true, `status ${status} should be valid`);
  }
});

test("AcDodMatrixItemSchema rejects extra fields", () => {
  const result = AcDodMatrixItemSchema.safeParse({ ...validItem, extra: "nope" });
  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// AcDodMatrixSchema
// ---------------------------------------------------------------------------

test("AcDodMatrixSchema accepts valid matrix", () => {
  const result = validateAcDodMatrix(validMatrix);
  assert.equal(result.success, true);
});

test("AcDodMatrixSchema rejects missing schema field", () => {
  const { schema, ...rest } = validMatrix;
  const result = validateAcDodMatrix(rest);
  assert.equal(result.success, false);
});

test("AcDodMatrixSchema rejects wrong schema value", () => {
  const result = validateAcDodMatrix({ ...validMatrix, schema: "wrong/v1" });
  assert.equal(result.success, false);
});

test("AcDodMatrixSchema rejects empty items array", () => {
  const result = validateAcDodMatrix({ ...validMatrix, items: [] });
  assert.equal(result.success, false);
});

test("AcDodMatrixSchema rejects missing items", () => {
  const { items, ...rest } = validMatrix;
  const result = validateAcDodMatrix(rest);
  assert.equal(result.success, false);
});

test("AcDodMatrixSchema rejects invalid item in array", () => {
  const result = validateAcDodMatrix({
    ...validMatrix,
    items: [{ item: "bad", type: "nope", status: "Met", evidence: "", notes: "" }],
  });
  assert.equal(result.success, false);
});

test("AcDodMatrixSchema rejects invalid generatedAt", () => {
  const result = validateAcDodMatrix({ ...validMatrix, generatedAt: "not-a-date" });
  assert.equal(result.success, false);
});

test("AcDodMatrixSchema rejects non-boolean isComplete", () => {
  const result = validateAcDodMatrix({ ...validMatrix, isComplete: "yes" });
  assert.equal(result.success, false);
});

test("AcDodMatrixSchema accepts optional source", () => {
  const { source, ...rest } = validMatrix;
  const result = validateAcDodMatrix(rest);
  assert.equal(result.success, true);
});

test("AcDodMatrixSchema rejects extra fields", () => {
  const result = validateAcDodMatrix({ ...validMatrix, extra: "nope" });
  assert.equal(result.success, false);
});

test("AcDodMatrixSchema complete matrix parses correctly", () => {
  const complete = {
    schema: "ac-dod-matrix/v1",
    items: [
      { ...validItem, status: AC_DOD_ITEM_STATUS.MET },
      {
        item: "All tests pass",
        type: AC_DOD_ITEM_TYPE.DOD,
        status: AC_DOD_ITEM_STATUS.MET,
        evidence: "npm run verify",
        notes: "",
      },
    ],
    generatedAt: "2026-06-08T12:00:00.000Z",
    isComplete: true,
  };
  const result = validateAcDodMatrix(complete);
  assert.equal(result.success, true);
  assert.equal(result.data.isComplete, true);
  assert.equal(result.data.items.length, 2);
});

// ---------------------------------------------------------------------------
// isMatrixComplete
// ---------------------------------------------------------------------------

test("isMatrixComplete returns true when all items Met", () => {
  const matrix = {
    items: [
      { ...validItem, status: AC_DOD_ITEM_STATUS.MET },
      { ...validItem, status: AC_DOD_ITEM_STATUS.MET },
    ],
  };
  assert.equal(isMatrixComplete(matrix), true);
});

test("isMatrixComplete returns false when any item is Partial", () => {
  const matrix = {
    items: [
      { ...validItem, status: AC_DOD_ITEM_STATUS.MET },
      { ...validItem, status: AC_DOD_ITEM_STATUS.PARTIAL },
    ],
  };
  assert.equal(isMatrixComplete(matrix), false);
});

test("isMatrixComplete returns false when any item is Unverified", () => {
  const matrix = {
    items: [
      { ...validItem, status: AC_DOD_ITEM_STATUS.UNVERIFIED },
    ],
  };
  assert.equal(isMatrixComplete(matrix), false);
});

test("isMatrixComplete returns false for null/empty input", () => {
  assert.equal(isMatrixComplete(null), false);
  assert.equal(isMatrixComplete({}), false);
  assert.equal(isMatrixComplete({ items: [] }), false);
});

// ---------------------------------------------------------------------------
// outstandingItems
// ---------------------------------------------------------------------------

test("outstandingItems returns non-Met items", () => {
  const matrix = {
    items: [
      { ...validItem, item: "Done", status: AC_DOD_ITEM_STATUS.MET },
      { ...validItem, item: "Pending", status: AC_DOD_ITEM_STATUS.UNVERIFIED },
      { ...validItem, item: "Partial", status: AC_DOD_ITEM_STATUS.PARTIAL },
    ],
  };
  const outstanding = outstandingItems(matrix);
  assert.equal(outstanding.length, 2);
  assert.equal(outstanding[0].item, "Pending");
  assert.equal(outstanding[1].item, "Partial");
});

test("outstandingItems returns empty when all Met", () => {
  const matrix = {
    items: [
      { ...validItem, status: AC_DOD_ITEM_STATUS.MET },
      { ...validItem, status: AC_DOD_ITEM_STATUS.MET },
    ],
  };
  assert.equal(outstandingItems(matrix).length, 0);
});

test("outstandingItems returns empty for null input", () => {
  assert.deepEqual(outstandingItems(null), []);
  assert.deepEqual(outstandingItems({}), []);
});

// ---------------------------------------------------------------------------
// validateAcDodMatrix
// ---------------------------------------------------------------------------

test("validateAcDodMatrix returns safeParse result with error details", () => {
  const result = validateAcDodMatrix({ schema: "wrong", items: [], generatedAt: "bad", isComplete: "nope" });
  assert.equal(result.success, false);
  assert.ok(result.error);
  assert.ok(result.error.issues.length > 0);
});

// ---------------------------------------------------------------------------
// Envelope refinementContract integration
// ---------------------------------------------------------------------------

test("handoff envelope accepts optional refinementContract field", async () => {
  const { buildDevLoopHandoffEnvelope, validateHandoffEnvelope } = await import("../src/loop/handoff-envelope.mjs");

  const resolverOutput = {
    bundle: {
      selectedStrategy: "copilot_pr_followup",
      executionMode: "bounded_handoff",
      nextAction: "Follow up on PR.",
      requiredReads: ["skills/copilot-pr-followup/SKILL.md"],
      activeArtifact: { kind: "issue", issue: 675, pr: 676, branch: null, phase: null },
    },
  };

  const options = {
    repoSlug: "mfittko/dev-loops",
    refinementContract: {
      schema: "ac-dod-matrix/v1",
      items: [validItem],
      generatedAt: "2026-06-08T12:00:00.000Z",
      isComplete: true,
    },
  };

  const envelope = buildDevLoopHandoffEnvelope(resolverOutput, {}, {}, options);
  const validation = validateHandoffEnvelope(envelope);

  assert.equal(validation.ok, true);
  assert.ok(envelope.refinementContract);
  assert.equal(envelope.refinementContract.schema, "ac-dod-matrix/v1");
  assert.equal(envelope.refinementContract.items.length, 1);
});

test("handoff envelope without refinementContract is still valid", async () => {
  const { buildDevLoopHandoffEnvelope, validateHandoffEnvelope } = await import("../src/loop/handoff-envelope.mjs");

  const resolverOutput = {
    bundle: {
      selectedStrategy: "copilot_pr_followup",
      executionMode: "bounded_handoff",
      nextAction: "Follow up on PR.",
      requiredReads: ["skills/copilot-pr-followup/SKILL.md"],
      activeArtifact: { kind: "issue", issue: 675, pr: 676, branch: null, phase: null },
    },
  };

  const options = { repoSlug: "mfittko/dev-loops" };
  const envelope = buildDevLoopHandoffEnvelope(resolverOutput, {}, {}, options);
  const validation = validateHandoffEnvelope(envelope);

  assert.equal(validation.ok, true);
  assert.equal(envelope.refinementContract, undefined);
});

test("handoff envelope fails on malformed refinementContract", async () => {
  const { buildDevLoopHandoffEnvelope, validateHandoffEnvelope } = await import("../src/loop/handoff-envelope.mjs");

  const resolverOutput = {
    bundle: {
      selectedStrategy: "copilot_pr_followup",
      executionMode: "bounded_handoff",
      nextAction: "Follow up on PR.",
      requiredReads: ["skills/copilot-pr-followup/SKILL.md"],
      activeArtifact: { kind: "issue", issue: 675, pr: 676, branch: null, phase: null },
    },
  };

  const options = {
    repoSlug: "mfittko/dev-loops",
    refinementContract: { schema: "wrong/v1", items: [], generatedAt: "bad", isComplete: "nope" },
  };

  const envelope = buildDevLoopHandoffEnvelope(resolverOutput, {}, {}, options);
  const validation = validateHandoffEnvelope(envelope);

  // Should fail (errors, not warnings) for the refinement contract shape
  // but items being empty IS an error
  assert.equal(validation.ok, false);
});

test("AcDodMatrixSchema rejects isComplete mismatch (true with non-Met items)", () => {
  const mismatch = {
    schema: "ac-dod-matrix/v1",
    items: [
      { ...validItem, status: AC_DOD_ITEM_STATUS.UNVERIFIED },
    ],
    generatedAt: "2026-06-08T12:00:00.000Z",
    isComplete: true,
  };
  const result = validateAcDodMatrix(mismatch);
  assert.equal(result.success, false);
  const isCompleteIssue = result.error?.issues?.find((i) => i.path?.includes?.("isComplete"));
  assert.ok(isCompleteIssue, "should have an issue on isComplete");
});

test("AcDodMatrixSchema rejects isComplete mismatch (false with all Met items)", () => {
  const mismatch = {
    schema: "ac-dod-matrix/v1",
    items: [
      { ...validItem, status: AC_DOD_ITEM_STATUS.MET },
    ],
    generatedAt: "2026-06-08T12:00:00.000Z",
    isComplete: false,
  };
  const result = validateAcDodMatrix(mismatch);
  assert.equal(result.success, false);
  const isCompleteIssue = result.error?.issues?.find((i) => i.path?.includes?.("isComplete"));
  assert.ok(isCompleteIssue, "should have an issue on isComplete");
});

test("handoff envelope refinementContract validation rejects per-item shape errors", async () => {
  const { buildDevLoopHandoffEnvelope, validateHandoffEnvelope } = await import("../src/loop/handoff-envelope.mjs");

  const resolverOutput = {
    bundle: {
      selectedStrategy: "copilot_pr_followup",
      executionMode: "bounded_handoff",
      nextAction: "Follow up on PR.",
      requiredReads: ["skills/copilot-pr-followup/SKILL.md"],
      activeArtifact: { kind: "issue", issue: 675, pr: 676, branch: null, phase: null },
    },
  };

  const options = {
    repoSlug: "mfittko/dev-loops",
    refinementContract: {
      schema: "ac-dod-matrix/v1",
      items: [
        { item: "ok", type: "AC", status: "Met", evidence: "x", notes: "" },
        { item: "", type: "AC", status: "Met", evidence: "x", notes: "" }, // bad: empty item
      ],
      generatedAt: "2026-06-08T12:00:00.000Z",
      isComplete: false,
    },
  };

  const envelope = buildDevLoopHandoffEnvelope(resolverOutput, {}, {}, options);
  const validation = validateHandoffEnvelope(envelope);

  assert.equal(validation.ok, false);
  const itemError = validation.errors.find((e) => e.field === "refinementContract.items" && e.reason.includes("entries at indices"));
  assert.ok(itemError, "should have per-item validation error for bad item shape");
});
