import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const fromRepoRoot = (relativePath) => new URL(`../../${relativePath}`, import.meta.url);
const readRepo = (relativePath) => readFile(fromRepoRoot(relativePath), 'utf8');

test('designer review loop doc remains the canonical bounded UI review handoff contract and the stale template is gone', async () => {
  const [doc, indexDoc, localImplementationSkill, visionTemplate] = await Promise.all([
    readRepo('docs/ui-designer-review-loop.md'),
    readRepo('docs/index.md'),
    readRepo('skills/local-implementation/SKILL.md'),
    readRepo('skills/dev-loop/templates/ui-vision-review.md'),
  ]);

  assert.match(doc, /designer-persona review loop/i);
  assert.match(doc, /single public entrypoint/i);
  assert.match(doc, /`dev-loop`/i);
  assert.match(doc, /acceptance criteria/i);
  assert.match(doc, /review brief/i);
  assert.match(doc, /artifact bundle/i);
  assert.match(doc, /test-results\/ui-smoke\/<sliceId>\/named-states\/<state-slug>/i);
  assert.match(doc, /continue_ui_fix_loop/i);
  assert.match(doc, /ui_review_satisfied/i);
  assert.match(doc, /blocked_needs_human_decision/i);
  assert.match(doc, /fails closed/i);
  assert.match(doc, /does not trigger for non-UI work/i);
  assert.match(doc, /uiReviewMode: vision/i);
  assert.match(doc, /ready_for_vision_review/i);
  assert.match(doc, /skills\/dev-loop\/templates\/ui-vision-review\.md/i);

  await assert.rejects(
    stat(fromRepoRoot('skills/dev-loop/templates/ui-designer-review.md')),
    (error) => error && error.code === 'ENOENT',
  );

  await stat(fromRepoRoot('skills/dev-loop/templates/ui-vision-review.md'));
  assert.match(visionTemplate, /gpt-5\.4/i);
  assert.match(visionTemplate, /screenshot\.png/i);
  assert.match(visionTemplate, /continue_ui_fix_loop/i);
  assert.match(visionTemplate, /ui_review_satisfied/i);
  assert.match(visionTemplate, /blocked_needs_human_decision/i);
  assert.match(indexDoc, /ui-designer-review-loop\.md/i);
  assert.match(localImplementationSkill, /\.\.\/\.\.\/docs\/ui-designer-review-loop\.md/i);
});
