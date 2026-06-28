import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateUiE2eScoping,
  classifyRenderedArtifactPath,
  REGISTERED_DECK_FILES,
} from "../src/loop/ui-e2e-scoping.mjs";
// Import the registries directly so the sync test fails if a deck is added to
// the harness without updating REGISTERED_DECK_FILES.
import { DECK_REGISTRY } from "../../../test/playwright/harness/deck-fit-harness.mjs";

test("classifies a presentation deck change as a registered rendered artifact", () => {
  const d = classifyRenderedArtifactPath("docs/presentations/introducing-dev-loops.html");
  assert.equal(d.kind, "deck");
  assert.equal(d.id, "introducing-dev-loops.html");
  assert.equal(d.registered, true);
});

test("classifies an article change and the viewer source", () => {
  assert.equal(classifyRenderedArtifactPath("docs/articles/dev-loops-deep-dive.html").registered, true);
  const v = classifyRenderedArtifactPath("scripts/loop/inspect-run-viewer.mjs");
  assert.equal(v.kind, "viewer");
  assert.equal(v.registered, true);
});

test("non-rendered and near-miss paths classify as null", () => {
  assert.equal(classifyRenderedArtifactPath("packages/core/src/loop/copilot-loop-state.mjs"), null);
  assert.equal(classifyRenderedArtifactPath("docs/articles/foo.md"), null, ".md is not rendered");
  assert.equal(classifyRenderedArtifactPath("docs/articles/sub/nested.html"), null, "glob is single-segment");
  assert.equal(classifyRenderedArtifactPath("README.md"), null);
});

test("trigger: a rendered-artifact change requires UI e2e", () => {
  const r = evaluateUiE2eScoping(
    ["docs/presentations/introducing-dev-loops.html", "README.md"],
    { uiE2ePassed: true },
  );
  assert.equal(r.required, true);
  assert.equal(r.satisfied, true);
  assert.equal(r.reason, null);
});

test("negative: a non-UI change does not require UI e2e", () => {
  const r = evaluateUiE2eScoping(["packages/core/src/loop/x.mjs", "README.md"]);
  assert.equal(r.required, false);
  assert.equal(r.satisfied, true);
});

test("fail-closed: unregistered rendered artifact blocks with a reason naming it", () => {
  const r = evaluateUiE2eScoping(["docs/articles/brand-new-page.html"], { uiE2ePassed: true });
  assert.equal(r.required, true);
  assert.equal(r.satisfied, false);
  assert.deepEqual(r.unregistered, ["brand-new-page.html"]);
  assert.match(r.reason, /brand-new-page\.html/);
  assert.match(r.reason, /not registered/);
});

test("fail-closed: registered artifact but suite not passed blocks", () => {
  const notRun = evaluateUiE2eScoping(["docs/presentations/introducing-dev-loops.html"], { uiE2ePassed: null });
  assert.equal(notRun.satisfied, false);
  assert.match(notRun.reason, /not passed for this head/);

  const failed = evaluateUiE2eScoping(["docs/presentations/introducing-dev-loops.html"], { uiE2ePassed: false });
  assert.equal(failed.satisfied, false);
});

test("REGISTERED_DECK_FILES stays in sync with DECK_REGISTRY", () => {
  const registryDecks = Object.values(DECK_REGISTRY).map((e) => e.deck).sort();
  assert.deepEqual([...REGISTERED_DECK_FILES].sort(), registryDecks);
});
