import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractRelativeMarkdownLinks } from '../../scripts/docs/validate-links.mjs';

const readRepo = (relativePath) => readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');

test('slides review has reachable sibling and template boundaries and names both outcomes', async () => {
  const [doc, indexDoc, uiDoc, template] = await Promise.all([
    readRepo('skills/docs/slides-story-review-loop.md'),
    readRepo('docs/index.md'),
    readRepo('skills/docs/ui-designer-review-loop.md'),
    readRepo('skills/dev-loop/templates/slides-story-review.md'),
  ]);
  assert.ok(extractRelativeMarkdownLinks(doc).some(({ rawTarget }) => rawTarget === './ui-designer-review-loop.md'));
  for (const caller of [indexDoc, uiDoc]) {
    assert.ok(extractRelativeMarkdownLinks(caller).some(({ rawTarget }) => rawTarget.endsWith('/slides-story-review-loop.md')));
  }
  assert.ok(doc.includes('skills/dev-loop/templates/slides-story-review.md'));
  for (const outcome of ['story_review_satisfied', 'needs_iteration']) {
    assert.ok(doc.includes(`\`${outcome}\``));
    assert.ok(template.includes(`"${outcome}"`));
  }
  // Arc, audience fit, iteration judgment and point-of-use authority are semantic
  // review obligations; a heading or sentence match cannot establish them.
});
