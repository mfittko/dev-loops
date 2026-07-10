import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fromRepoRoot = (relativePath) => new URL(`../../${relativePath}`, import.meta.url);
const readRepo = (relativePath) => readFile(fromRepoRoot(relativePath), 'utf8');

test('ui smoke harness doc defines the bounded reusable local Playwright/WebKit baseline', async () => {
  const [doc, indexDoc, localImplementationSkill] = await Promise.all([
    readRepo('docs/ui-smoke-harness.md'),
    readRepo('docs/index.md'),
    readRepo('skills/local-implementation/SKILL.md'),
  ]);

  // Durable module + seam symbols instead of the descriptive sentence around them.
  assert.match(doc, /webkit-smoke-harness\.mjs/i);
  assert.match(doc, /captureNamedUiState/);
  assert.match(doc, /ui-e2e-scoping-step\.md/i);
  assert.match(doc, /Playwright/i);
  assert.match(doc, /WebKit only/i);
  assert.match(doc, /fixture-backed/i);

  // Each named-state artifact filename is documented — catches a removed artifact
  // type, tolerates reordering/rewording of the capture line.
  for (const artifact of ['screenshot.png', 'state.json', 'snapshot.json', 'axe.json', 'console.json']) {
    assert.match(doc, new RegExp(artifact.replace('.', '\\.'), 'i'), `doc must document artifact ${artifact}`);
  }

  // Canonical output directory anchors for the reference viewer slice.
  assert.match(doc, /test-results\/ui-smoke\/inspect-run-viewer/i);
  assert.match(doc, /playwright-report\/ui-smoke\/inspect-run-viewer/i);
  assert.match(doc, /ui-artifact-contract\.md/i);

  // Scope boundary: a bounded seam, not a general E2E framework, not mandatory for non-UI slices.
  assert.doesNotMatch(doc, /later bounded decision/i);
  assert.match(doc, /not a general E2E framework/i);
  // Anchor the negation on the mandatory clause's verb (not any earlier "not"),
  // so a flip ("does make browser validation mandatory for non-UI slices") trips,
  // while tolerating rewording of the middle clause.
  assert.match(doc, /not make[^.]*mandatory[^.]*non-UI slices/i);
  assert.match(indexDoc, /ui-smoke-harness\.md/i);
  assert.match(localImplementationSkill, /\.\.\/\.\.\/docs\/ui-smoke-harness\.md/i);
});
