import assert from "node:assert/strict";
import test from "node:test";

import { classifyRenderedArtifactCiChanges } from "../../scripts/loop/rendered-artifact-ci-changes.mjs";

test("rendered artifact CI classifier scopes presentation and article sources independently", () => {
  assert.deepEqual(classifyRenderedArtifactCiChanges(["docs/presentations/state-graph-surface.html"]), {
    presentations: true,
    articles: false,
    presentationPaths: ["docs/presentations/state-graph-surface.html"],
    articlePaths: [],
  });
  assert.equal(classifyRenderedArtifactCiChanges(["docs/articles/example.html"]).articles, true);
  assert.deepEqual(classifyRenderedArtifactCiChanges(["docs/presentations/nested/example.html"]), {
    presentations: false,
    articles: false,
    presentationPaths: [],
    articlePaths: [],
  });
});

test("rendered artifact CI classifier covers every deck spec and shared runtime input", () => {
  assert.equal(classifyRenderedArtifactCiChanges(["test/playwright/how-decided-deck.spec.mjs"]).presentations, true);
  assert.equal(classifyRenderedArtifactCiChanges(["test/playwright/how-decided-deck.spec.mjs"]).articles, false);
  for (const path of [
    "scripts/loop/ui-review-capture.mjs",
    "package.json",
    "bun.lock",
    ".github/actions/playwright-webkit/action.yml",
    ".github/workflows/ci.yml",
  ]) {
    const result = classifyRenderedArtifactCiChanges([path]);
    assert.equal(result.presentations, true, `${path} triggers presentation smoke`);
    assert.equal(result.articles, true, `${path} triggers article smoke`);
  }
});

test("rendered artifact CI classifier normalizes and deduplicates paths", () => {
  const result = classifyRenderedArtifactCiChanges([" ./test/playwright/new-deck.spec.mjs ", "test/playwright/new-deck.spec.mjs"]);
  assert.deepEqual(result.presentationPaths, ["test/playwright/new-deck.spec.mjs"]);
});

test("original Simulator views and their shared harness schedule article browser CI", () => {
  for (const path of [
    "docs/articles/simulator.html",
    "docs/articles/simulator-overview.html",
    "docs/articles/assets/simulator-model.mjs",
    "docs/articles/assets/simulator-overview-model.mjs",
    "test/playwright/harness/simulator-harness.mjs",
    "test/playwright/simulator-article.spec.mjs",
    "test/playwright/simulator-overview-article.spec.mjs",
  ]) {
    const result = classifyRenderedArtifactCiChanges([path]);
    assert.equal(result.articles, true);
    assert.equal(result.presentations, false);
    assert.deepEqual(result.articlePaths, [path]);
  }
});
