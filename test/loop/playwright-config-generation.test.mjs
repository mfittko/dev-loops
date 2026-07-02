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

test('playwright.config generates one webkit project per registered slice', () => {
  const projects = playwrightConfig.projects;
  assert.ok(Array.isArray(projects), 'config exposes a projects array');

  const names = projects.map((p) => p.name);
  for (const name of names) {
    assert.ok(typeof name === 'string' && name.length > 0, 'each project.name is a non-empty string');
  }
  // Playwright requires unique project names; a duplicate sliceId would still
  // pass a set-based comparison, so assert uniqueness explicitly.
  assert.equal(new Set(names).size, names.length, 'project names are unique');

  const projectNames = [...names].sort();
  assert.deepEqual(projectNames, [...expectedSliceIds].sort());

  for (const project of projects) {
    const sliceId = project.name;
    assert.equal(project.name, sliceId);
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
});
