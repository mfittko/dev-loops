import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateUiE2eScoping,
  classifyRenderedArtifactPath,
  REGISTERED_ARTIFACT_PATHS,
} from "../src/loop/ui-e2e-scoping.mjs";
// Import the registries directly so the sync test fails if a deck/article is
// added to the harness without updating REGISTERED_ARTIFACT_PATHS.
import { DECK_REGISTRY, ARTICLE_REGISTRY } from "../../../test/playwright/harness/deck-fit-harness.mjs";

test("classifies a presentation deck change as a registered rendered artifact (full path id)", () => {
  const d = classifyRenderedArtifactPath("docs/presentations/introducing-dev-loops.html");
  assert.equal(d.kind, "deck");
  assert.equal(d.id, "docs/presentations/introducing-dev-loops.html");
  assert.equal(d.registered, true);
});

test("classifies a registered article change and the viewer source", () => {
  const a = classifyRenderedArtifactPath("docs/articles/dev-loops-deep-dive.html");
  assert.equal(a.kind, "article");
  assert.equal(a.id, "docs/articles/dev-loops-deep-dive.html");
  assert.equal(a.registered, true);
  const v = classifyRenderedArtifactPath("scripts/loop/inspect-run-viewer.mjs");
  assert.equal(v.kind, "viewer");
  assert.equal(v.registered, true);
});

// Regression for the basename-collision false positive: an article and a deck
// that share a basename are DISTINCT artifacts. A NEW article basename that
// happens to match a registered deck must NOT be aliased onto the deck.
test("an article path is not aliased onto a deck that shares its basename", () => {
  // introducing-dev-loops.html exists as BOTH a deck and an article; both are
  // registered, but at distinct full paths — neither borrows the other's id.
  const deck = classifyRenderedArtifactPath("docs/presentations/introducing-dev-loops.html");
  const article = classifyRenderedArtifactPath("docs/articles/introducing-dev-loops.html");
  assert.notEqual(deck.id, article.id);
  assert.equal(deck.kind, "deck");
  assert.equal(article.kind, "article");

  // A deck basename used for an UNregistered article path must fail closed,
  // not be covered by the deck's registration.
  const orphan = classifyRenderedArtifactPath("docs/articles/dev-loops-deep-dive-NEW.html");
  // (sanity: distinct unregistered article)
  assert.equal(orphan.kind, "article");
  assert.equal(orphan.registered, false);
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

test("fail-closed: unregistered rendered artifact blocks with a reason naming its full path", () => {
  const r = evaluateUiE2eScoping(["docs/articles/brand-new-page.html"], { uiE2ePassed: true });
  assert.equal(r.required, true);
  assert.equal(r.satisfied, false);
  assert.deepEqual(r.unregistered, ["docs/articles/brand-new-page.html"]);
  assert.match(r.reason, /docs\/articles\/brand-new-page\.html/);
  assert.match(r.reason, /not registered/);
});

test("fail-closed: registered artifact but suite not passed blocks", () => {
  const notRun = evaluateUiE2eScoping(["docs/presentations/introducing-dev-loops.html"], { uiE2ePassed: null });
  assert.equal(notRun.satisfied, false);
  assert.match(notRun.reason, /not passed for this head/);

  const failed = evaluateUiE2eScoping(["docs/presentations/introducing-dev-loops.html"], { uiE2ePassed: false });
  assert.equal(failed.satisfied, false);
});

test("REGISTERED_ARTIFACT_PATHS stays in sync with DECK_REGISTRY and ARTICLE_REGISTRY", () => {
  const deckPaths = Object.values(DECK_REGISTRY).map((e) => `docs/presentations/${e.deck}`);
  const articlePaths = Object.values(ARTICLE_REGISTRY).map((e) => `docs/articles/${e.file}`);
  assert.deepEqual(
    [...REGISTERED_ARTIFACT_PATHS].sort(),
    [...deckPaths, ...articlePaths].sort(),
  );
});
