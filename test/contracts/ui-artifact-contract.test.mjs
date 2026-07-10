import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fromRepoRoot = (relativePath) => new URL(`../../${relativePath}`, import.meta.url);
const readRepo = (relativePath) => readFile(fromRepoRoot(relativePath), 'utf8');

test('ui artifact contract doc defines named-state artifacts and auto-scoped CI enforcement', async () => {
  const [doc, indexDoc, localImplementationSkill, ciWorkflow] = await Promise.all([
    readRepo('docs/ui-artifact-contract.md'),
    readRepo('docs/index.md'),
    readRepo('skills/local-implementation/SKILL.md'),
    readRepo('.github/workflows/ci.yml'),
  ]);

  // dev-loop is the single public entrypoint — pin the token, not the sentence around it.
  assert.match(doc, /`dev-loop`/i);

  // The five named-state artifact filenames are the load-bearing bundle contract.
  for (const artifact of ['screenshot.png', 'state.json', 'snapshot.json', 'axe.json', 'console.json']) {
    assert.match(doc, new RegExp(artifact.replace('.', '\\.'), 'i'), `doc must document artifact ${artifact}`);
  }
  assert.match(doc, /axe-core/i);

  // Canonical artifact directory layout anchor.
  assert.match(doc, /test-results\/ui-smoke\/<sliceId>\/named-states\/<state-slug>/i);

  // Both tiers are documented: screenshot-alone vs the required bundle. Match the
  // durable tokens so a legitimate reword of the surrounding prose does not break.
  assert.match(doc, /screenshot alone/i);
  assert.match(doc, /bundle is required/i);

  // Auto-scoped (not opt-in / promoted) CI enforcement — the durable `auto-scoped`
  // token also backs the section anchor other docs link to.
  assert.match(doc, /auto-scoped/i);
  assert.match(doc, /ui-e2e-scoping-step\.md/i);
  assert.match(doc, /UI_E2E_CHECK_NAMES/i);

  // Fail-closed on missing/malformed required artifacts.
  assert.match(doc, /missing or malformed/i);
  assert.match(doc, /viewer-smoke/i);
  assert.match(indexDoc, /ui-artifact-contract\.md/i);
  assert.match(localImplementationSkill, /\.\.\/\.\.\/docs\/ui-artifact-contract\.md/i);
  assert.match(ciWorkflow, /viewer-smoke:/i);
});
