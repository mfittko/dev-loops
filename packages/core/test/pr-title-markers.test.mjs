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

  // Deliberate loosening (issue #1529): a bare marker word mid-title with no
  // bracket/paren/colon/standalone construction is a real title, not a
  // status claim, and stays unflagged even though the old substring matcher
  // used to flag it.
  { title: "WIP foo bar", expect: [] },
  { title: "DRAFT some title", expect: [] },
  // A dash-set-off trailing tag (hyphen, en dash, or em dash) is not its
  // own construction — see the module comment for why — so it stays
  // unflagged; `WIP:`/`DRAFT:` remains one keystroke away.
  { title: "WIP - add feature", expect: [] },
  { title: "Fix login flow — WIP", expect: [] },
  { title: "– DRAFT – new module", expect: [] },
  { title: "Fix login flow — WIP.", expect: [] },
  { title: "— WIP, needs tests", expect: [] },
  { title: "— WIP (rebasing)", expect: [] },
  { title: "Fix login — DRAFT!", expect: [] },
  // A dash joiner other than a plain hyphen must not re-admit the
  // compound-noun false positive either.
  { title: "Handle en dash–draft–gate naming", expect: [] },
  { title: "Rename review—draft—mode config", expect: [] },
  { title: "Migrate to RFC 8259–draft", expect: [] },

  // A conventional-commit scope naming a component that happens to share the
  // marker word is a component name, not a status claim — the bracket/paren
  // constructions require the delimiter to sit at a title/whitespace
  // boundary, never directly after a letter or `/`.
  { title: "fix(draft): support x", expect: [] },
  { title: "feat(wip): retry", expect: [] },
  { title: "fix(routes): rename app/[draft]/page.tsx", expect: [] },

  // A hyphen-prefixed compound is one word split by a hyphen, not a
  // colon-suffixed status tag.
  { title: "re-draft: cleanup", expect: [] },

  // A colon-suffixed scoped label naming a component is not a status claim —
  // the colon construction's opening anchor excludes a preceding `/`, same
  // exemption class as the bracket/paren anchoring above.
  { title: "feat/draft: x", expect: [] },
  { title: "app/draft: page", expect: [] },
  { title: "docs/wip: notes", expect: [] },

  // A colon that does not CLOSE the tag (immediately followed by another
  // character, not whitespace or end-of-title) is a scheme/tag/ref, not a
  // status claim.
  { title: "draft:latest", expect: [] },
  { title: "wip:branch", expect: [] },
  { title: "draft://", expect: [] },

  // A dash-introduced clause that merely CONTAINS the marker word as part
  // of a longer phrase or a hyphen-joined compound noun stays unflagged,
  // the same false-positive class the bracket/paren/colon constructions
  // already guard against.
  { title: "Rework the pipeline — draft-gate override", expect: [] },
  { title: "Refactor — draft gate coordination", expect: [] },
  { title: "Bound the findings comment — draft-gate + pre-approval-gate parity", expect: [] },
  { title: "Improve tooling — wip-branch cleanup", expect: [] },
  { title: "Retry — wip branch pipeline", expect: [] },
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
