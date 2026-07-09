import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import playwrightConfig from '../../playwright.config.mjs';
import { ARTICLE_REGISTRY, DECK_REGISTRY } from '../playwright/harness/deck-fit-harness.mjs';
import { VIEWER_REGISTRY } from '../playwright/harness/inspect-run-viewer-harness.mjs';
import { normalizeUiStateSegment } from '../playwright/harness/webkit-smoke-harness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const expectedSliceIds = [
  ...Object.values(DECK_REGISTRY).map((entry) => entry.sliceId),
  ...Object.values(ARTICLE_REGISTRY).map((entry) => entry.sliceId),
  VIEWER_REGISTRY.sliceId,
];

// The config holds two kinds of webkit projects:
//   1. rendered-artifact slice projects, auto-generated one-per-registry-entry
//      (DECK/ARTICLE/VIEWER) — the generation invariant below pins these exactly.
//   2. non-slice harness projects: net-new specs that reuse the webkit engine but
//      drive an arbitrary running app, so they don't belong to any registry. These
//      are declared explicitly in the config and are NOT held to the rendered-
//      artifact sliceId == normalized-segment / test-results/ui-smoke coupling.
const NON_SLICE_PROJECT_NAMES = new Set(['ui-review-drive']);

test('playwright.config generates one webkit project per registered slice', () => {
  const projects = playwrightConfig.projects;
  assert.ok(Array.isArray(projects), 'config exposes a projects array');

  const names = projects.map((p) => p.name);
  for (const name of names) {
    assert.ok(typeof name === 'string' && name.length > 0, 'each project.name is a non-empty string');
  }
  // Playwright requires unique project names; a duplicate name would still
  // pass a set-based comparison, so assert uniqueness explicitly across ALL
  // projects (slice and non-slice alike).
  assert.equal(new Set(names).size, names.length, 'project names are unique');

  const sliceProjects = projects.filter((p) => !NON_SLICE_PROJECT_NAMES.has(p.name));
  const nonSliceProjects = projects.filter((p) => NON_SLICE_PROJECT_NAMES.has(p.name));

  // (a) The rendered-artifact slice projects match the registries exactly —
  // adding/removing a slice must be a registry edit, not a config edit.
  const sliceNames = sliceProjects.map((p) => p.name).sort();
  assert.deepEqual(sliceNames, [...expectedSliceIds].sort());

  for (const project of sliceProjects) {
    const sliceId = project.name;
    // Config enforces sliceId == normalized form so test-results/ui-smoke/<sliceId>
    // matches the artifact path segment the harness writes.
    assert.equal(project.name, normalizeUiStateSegment(project.name));
    assert.deepEqual(project.testMatch, [`${sliceId}.spec.mjs`]);
    assert.equal(project.outputDir, `test-results/ui-smoke/${sliceId}`);
    assert.equal(project.use.browserName, 'webkit');

    // Guards the sliceId == spec-basename coupling AC #4 relies on.
    assert.ok(
      existsSync(path.join(repoRoot, 'test', 'playwright', `${sliceId}.spec.mjs`)),
      `spec test/playwright/${sliceId}.spec.mjs must exist on disk`,
    );
  }

  // (b) Every declared non-slice harness project must be present and well-formed:
  // it reuses the webkit engine and pins a real, existing spec — but it is NOT
  // asserted to be a rendered-artifact slice.
  const nonSliceNames = new Set(nonSliceProjects.map((p) => p.name));
  for (const expected of NON_SLICE_PROJECT_NAMES) {
    assert.ok(nonSliceNames.has(expected), `non-slice harness project "${expected}" must be declared`);
  }
  for (const project of nonSliceProjects) {
    assert.equal(project.use.browserName, 'webkit');
    assert.ok(Array.isArray(project.testMatch) && project.testMatch.length === 1, 'harness project pins one spec');
    const specBasename = project.testMatch[0];
    assert.ok(
      existsSync(path.join(repoRoot, 'test', 'playwright', specBasename)),
      `spec test/playwright/${specBasename} must exist on disk`,
    );
  }
});
