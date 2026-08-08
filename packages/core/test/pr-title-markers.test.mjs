import assert from "node:assert/strict";
import test from "node:test";

import { findBlockingTitleMarkers } from "../src/loop/pr-title-markers.mjs";

// Table-driven: every accepted (still-flagged status marker) and rejected
// (unflagged component name / false-positive guard) title form, for both
// WIP and DRAFT.
const CASES = [
  // Genuine status markers stay flagged, for both marker words.
  { title: "WIP", expect: ["WIP"] },
  { title: "wip", expect: ["WIP"] },
  { title: "[WIP] add feature", expect: ["WIP"] },
  { title: "Fix login (wip)", expect: ["WIP"] },
  { title: "WIP: add feature", expect: ["WIP"] },
  { title: "DRAFT", expect: ["DRAFT"] },
  { title: "draft", expect: ["DRAFT"] },
  { title: "Add module [draft]", expect: ["DRAFT"] },
  { title: "Fix bug (DRAFT)", expect: ["DRAFT"] },
  { title: "DRAFT: new module", expect: ["DRAFT"] },
  { title: "draft: new module", expect: ["DRAFT"] },

  // Component names — a hyphen, underscore, or space joining the marker
  // word into a compound noun phrase is not a status claim.
  { title: "fix(gate): drop the repo-local draft-gate override", expect: [] },
  { title: "Document the draft gate behavior", expect: [] },
  { title: "Rename draft_gate module", expect: [] },
  { title: "Retry the wip-branch pipeline", expect: [] },
  { title: "Rebase wip branch onto main", expect: [] },
  { title: "Clean up wip_branch fixtures", expect: [] },

  // Pre-existing true-negative guards named in the module comment.
  { title: "Improve swipe gesture handling", expect: [] },
  { title: "Cache is wiped on logout", expect: [] },
  { title: "Improve drafting workflow", expect: [] },
  { title: "Redraft the proposal copy", expect: [] },

  // Unrelated markers, unaffected by the WIP/DRAFT change.
  { title: "DO NOT MERGE - blocked on infra", expect: ["DO NOT MERGE"] },
  { title: "Fix bug (do   not\tmerge)", expect: ["DO NOT MERGE"] },
  { title: "DOI NOT MERGEABLE registry", expect: [] },
  { title: "Refactor pipeline 🚧", expect: ["🚧"] },
  { title: "🚧 still building", expect: ["🚧"] },

  // Clean and mixed-marker titles.
  { title: "Add user authentication flow", expect: [] },
  { title: "DO NOT MERGE [WIP] 🚧", expect: ["WIP", "DO NOT MERGE", "🚧"] },
  { title: "WIP wip [WIP]", expect: ["WIP"] },
  { title: "[WIP] [DRAFT]", expect: ["WIP", "DRAFT"] },
];

for (const { title, expect } of CASES) {
  test(`findBlockingTitleMarkers(${JSON.stringify(title)}) -> ${JSON.stringify(expect)}`, () => {
    assert.deepEqual(findBlockingTitleMarkers(title), expect);
  });
}

test("empty string returns empty array", () => {
  assert.deepEqual(findBlockingTitleMarkers(""), []);
});

test("null returns empty array", () => {
  assert.deepEqual(findBlockingTitleMarkers(null), []);
});

test("undefined returns empty array", () => {
  assert.deepEqual(findBlockingTitleMarkers(undefined), []);
});

test("non-string returns empty array", () => {
  assert.deepEqual(findBlockingTitleMarkers(42), []);
  assert.deepEqual(findBlockingTitleMarkers({ title: "WIP" }), []);
});

test("repeated markers are de-duped", () => {
  assert.deepEqual(findBlockingTitleMarkers("WIP wip [WIP]"), ["WIP"]);
});
