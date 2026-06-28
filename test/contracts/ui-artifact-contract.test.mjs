import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fromRepoRoot = (relativePath) => new URL(`../../${relativePath}`, import.meta.url);
const readRepo = (relativePath) => readFile(fromRepoRoot(relativePath), 'utf8');

test('ui artifact contract doc defines named-state artifacts and auto-scoped CI enforcement', async () => {
  const [doc, readme, indexDoc, localImplementationSkill, ciWorkflow] = await Promise.all([
    readRepo('docs/ui-artifact-contract.md'),
    readRepo('README.md'),
    readRepo('docs/index.md'),
    readRepo('skills/local-implementation/SKILL.md'),
    readRepo('.github/workflows/ci.yml'),
  ]);

  assert.match(doc, /single public entrypoint/i);
  assert.match(doc, /`dev-loop`/i);
  assert.match(doc, /named UI state/i);
  assert.match(doc, /screenshot\.png/i);
  assert.match(doc, /state\.json/i);
  assert.match(doc, /test-results\/ui-smoke\/<sliceId>\/named-states\/<state-slug>/i);
  assert.match(doc, /screenshot alone is acceptable/i);
  assert.match(doc, /paired state artifact is required/i);
  assert.match(doc, /CI enforcement is auto-scoped, not promoted/i);
  assert.match(doc, /ui-e2e-scoping-step\.md/i);
  assert.match(doc, /UI_E2E_CHECK_NAMES/i);
  assert.match(doc, /missing or malformed/i);
  assert.match(doc, /viewer-smoke/i);

  assert.match(readme, /docs\/ui-artifact-contract\.md/i);
  assert.match(indexDoc, /ui-artifact-contract\.md/i);
  assert.match(localImplementationSkill, /\.\.\/\.\.\/docs\/ui-artifact-contract\.md/i);
  assert.match(ciWorkflow, /viewer-smoke:/i);
});
