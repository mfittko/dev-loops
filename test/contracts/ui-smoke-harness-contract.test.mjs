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

  assert.match(doc, /minimal reusable local WebKit config\/server\/capture seam/i);
  assert.match(doc, /ui-e2e-scoping-step\.md/i);
  assert.match(doc, /Playwright/i);
  assert.match(doc, /WebKit only/i);
  assert.match(doc, /fixture-backed/i);
  assert.match(doc, /named screenshot\/state\/snapshot\/axe\/console artifact capture/i);
  assert.match(doc, /test-results\/ui-smoke\/inspect-run-viewer/i);
  assert.match(doc, /playwright-report\/ui-smoke\/inspect-run-viewer/i);
  assert.match(doc, /ui-artifact-contract\.md/i);
  assert.doesNotMatch(doc, /later bounded decision/i);
  assert.match(doc, /not a general E2E framework/i);
  assert.match(doc, /does not make browser validation mandatory for non-UI slices/i);
  assert.match(indexDoc, /ui-smoke-harness\.md/i);
  assert.match(localImplementationSkill, /\.\.\/\.\.\/docs\/ui-smoke-harness\.md/i);
});
