import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const fromRepoRoot = (relativePath) => new URL(`../../${relativePath}`, import.meta.url);
const readRepo = (relativePath) => readFile(fromRepoRoot(relativePath), 'utf8');

test('slides-story review loop doc carries the required headings/sections and cross-links', async () => {
  const [doc, readme, indexDoc, uiDoc, template] = await Promise.all([
    readRepo('docs/slides-story-review-loop.md'),
    readRepo('README.md'),
    readRepo('docs/index.md'),
    readRepo('docs/ui-designer-review-loop.md'),
    readRepo('skills/dev-loop/templates/slides-story-review.md'),
  ]);

  assert.match(doc, /storytelling review loop/i);
  assert.match(doc, /single public entrypoint/i);
  assert.match(doc, /`dev-loop`/i);
  assert.match(doc, /acceptance criteria/i);
  assert.match(doc, /storytelling brief/i);
  assert.match(doc, /deck source/i);
  assert.match(doc, /required input bundle/i);
  assert.match(doc, /required output bundle/i);
  assert.match(doc, /review lens/i);
  assert.match(doc, /story_review_satisfied/i);
  assert.match(doc, /needs_iteration/i);
  assert.match(doc, /fails closed/i);
  assert.match(doc, /skip_non_slides/i);
  assert.match(doc, /skills\/dev-loop\/templates\/slides-story-review\.md/i);
  // sibling cross-link to the UI loop
  assert.match(doc, /ui-designer-review-loop\.md/i);
  // first-two-runs evidence
  assert.match(doc, /applied-dev-loops-review-notes\.md/i);
  assert.match(doc, /process-observability-review-notes\.md/i);

  // the UI doc cross-links back as a sibling
  assert.match(uiDoc, /slides-story-review-loop\.md/i);

  // the dev-loop indexes list the loop
  assert.match(readme, /docs\/slides-story-review-loop\.md/i);
  assert.match(indexDoc, /slides-story-review-loop\.md/i);

  // template exists with the storytelling lens and bounded outcomes
  await stat(fromRepoRoot('skills/dev-loop/templates/slides-story-review.md'));
  assert.match(template, /storytelling/i);
  assert.match(template, /one message per slide/i);
  assert.match(template, /story_review_satisfied/i);
  assert.match(template, /needs_iteration/i);
});
