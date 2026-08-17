import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateUiDesignerReviewScoping,
  normalizeDesignerReviewEvidence,
  DESIGNER_REVIEW_SATISFIED_OUTCOME,
  DESIGNER_REVIEW_OUTCOMES,
} from "../src/loop/ui-designer-review-scoping.mjs";

test("evidence shape reuses the loop's existing outcome + bundle (no new schema)", () => {
  const record = { artifact: "docs/presentations/introducing-dev-loops.html", outcome: DESIGNER_REVIEW_SATISFIED_OUTCOME };
  const map = normalizeDesignerReviewEvidence([record]);
  assert.equal(map.get(record.artifact).outcome, DESIGNER_REVIEW_SATISFIED_OUTCOME);
  // The outcome enum is the loop's existing one, byte-for-byte.
  assert.deepEqual(
    [...DESIGNER_REVIEW_OUTCOMES].sort(),
    ["blocked_needs_human_decision", "continue_ui_fix_loop", "ui_review_satisfied"].sort(),
  );
});

test("keyed-object evidence shape normalizes identically", () => {
  const map = normalizeDesignerReviewEvidence({
    "docs/articles/introducing-dev-loops.html": { outcome: DESIGNER_REVIEW_SATISFIED_OUTCOME },
  });
  assert.equal(map.get("docs/articles/introducing-dev-loops.html").outcome, DESIGNER_REVIEW_SATISFIED_OUTCOME);
});

test("null/absent evidence maps to empty (fails closed later)", () => {
  assert.equal(normalizeDesignerReviewEvidence(null).size, 0);
  assert.equal(normalizeDesignerReviewEvidence(undefined).size, 0);
});

test("trigger: a rendered-artifact change with satisfied recorded evidence passes", () => {
  const r = evaluateUiDesignerReviewScoping(
    ["docs/presentations/introducing-dev-loops.html", "README.md"],
    {
      designerReviewEvidence: [
        { artifact: "docs/presentations/introducing-dev-loops.html", outcome: DESIGNER_REVIEW_SATISFIED_OUTCOME },
      ],
    },
  );
  assert.equal(r.required, true);
  assert.equal(r.satisfied, true);
  assert.equal(r.reason, null);
});

test("negative: a non-rendered change does not require designer review evidence", () => {
  const r = evaluateUiDesignerReviewScoping(["packages/core/src/loop/x.mjs", "README.md"]);
  assert.equal(r.required, false);
  assert.equal(r.satisfied, true);
});

test("fail-closed: rendered-artifact change with no recorded evidence blocks, naming the artifact", () => {
  const r = evaluateUiDesignerReviewScoping(["docs/articles/brand-new-page.html"]);
  assert.equal(r.required, true);
  assert.equal(r.satisfied, false);
  assert.deepEqual(r.missing, ["docs/articles/brand-new-page.html"]);
  assert.match(r.reason, /docs\/articles\/brand-new-page\.html/);
  assert.match(r.reason, /no recorded designer\/vision review/);
});

test("fail-closed: recorded evidence present but unsatisfied outcome blocks", () => {
  const r = evaluateUiDesignerReviewScoping(["docs/presentations/introducing-dev-loops.html"], {
    designerReviewEvidence: [
      { artifact: "docs/presentations/introducing-dev-loops.html", outcome: "continue_ui_fix_loop" },
    ],
  });
  assert.equal(r.required, true);
  assert.equal(r.satisfied, false);
  assert.deepEqual(r.unsatisfied, ["docs/presentations/introducing-dev-loops.html"]);
  assert.match(r.reason, /ui_review_satisfied/);
});

test("fail-closed: recorded outcome absent on an otherwise-matched record blocks", () => {
  const r = evaluateUiDesignerReviewScoping(["docs/articles/introducing-dev-loops.html"], {
    designerReviewEvidence: [{ artifact: "docs/articles/introducing-dev-loops.html", outcome: undefined }],
  });
  assert.equal(r.satisfied, false);
  assert.deepEqual(r.unsatisfied, ["docs/articles/introducing-dev-loops.html"]);
});

test("carve-out: light/spike relaxed-gate profile exempts the requirement", () => {
  const r = evaluateUiDesignerReviewScoping(["docs/presentations/brand-new-deck.html"], {
    designerReviewEvidence: null,
    designerReviewExempt: true,
  });
  assert.equal(r.required, true);
  assert.equal(r.satisfied, true);
  assert.equal(r.reason, "exempted_by_relaxed_gate_profile");
});

test("multi-artifact: every touched rendered artifact must carry satisfied evidence", () => {
  const r = evaluateUiDesignerReviewScoping(
    ["docs/presentations/introducing-dev-loops.html", "docs/articles/introducing-dev-loops.html"],
    {
      designerReviewEvidence: [
        { artifact: "docs/presentations/introducing-dev-loops.html", outcome: DESIGNER_REVIEW_SATISFIED_OUTCOME },
      ],
    },
  );
  assert.equal(r.satisfied, false);
  assert.deepEqual(r.missing, ["docs/articles/introducing-dev-loops.html"]);
});

test("viewer model: source-only change does not require designer evidence (#1443 regression)", () => {
  // The shared classifier recognizes the headless viewer source as a "viewer"
  // artifact; the designer requirement applies only to rendered HTML, so a
  // viewer-source-only change must not demand designer/vision evidence.
  const r = evaluateUiDesignerReviewScoping(["scripts/loop/inspect-run-viewer.mjs", "README.md"]);
  assert.equal(r.required, false);
  assert.equal(r.satisfied, true);
  assert.deepEqual(r.artifacts, []);
});

test("viewer model: viewer + rendered artifact change still requires designer evidence for the rendered one", () => {
  const r = evaluateUiDesignerReviewScoping(
    ["scripts/loop/inspect-run-viewer.mjs", "docs/articles/new-page.html"],
    { designerReviewEvidence: null },
  );
  assert.equal(r.required, true);
  assert.equal(r.satisfied, false);
  assert.deepEqual(r.missing, ["docs/articles/new-page.html"]);
  assert.deepEqual(r.artifacts.map((a) => a.kind), ["article"]);
});
