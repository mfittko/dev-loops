import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSite, injectNav, ARTICLES, DECKS, NAV_LINKS } from '../../scripts/pages/build-site.mjs';

test('build-site: index is the intro article, all resources published, nav links the others', async () => {
  const out = await mkdtemp(join(tmpdir(), 'pages-site-'));
  try {
    const result = await buildSite({ outDir: out });

    // Every deep-dive article and deck is published alongside the index.
    for (const r of [...ARTICLES, ...DECKS]) {
      await stat(join(out, r.file)); // throws if missing
    }

    const index = await readFile(join(out, 'index.html'), 'utf8');
    // The landing page is the intro article (its content), not the old deck index.
    assert.ok(index.includes('Introducing dev-loops'), 'index is the intro article');
    assert.ok(!index.includes('<h1>Presentation Decks</h1>'), 'old deck-index landing is gone');
    // The nav links every other resource.
    for (const l of NAV_LINKS) {
      assert.ok(index.includes(`href="${l.file}"`), `nav links ${l.file}`);
      assert.ok(index.includes(`>${l.label}</a>`), `nav shows ${l.label}`);
    }
    assert.ok(index.includes('class="site-nav"'), 'index carries the nav bar');

    // Deep-dive articles also carry the nav so the set is navigable.
    const deep = await readFile(join(out, ARTICLES[0].file), 'utf8');
    assert.ok(deep.includes('class="site-nav"'), 'deep-dive article carries the nav bar');

    assert.deepEqual(
      result.files.sort(),
      ['index.html', ...ARTICLES.map((a) => a.file), ...DECKS.map((d) => d.file)].sort(),
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('injectNav fails closed when a page lacks the expected structure', () => {
  assert.throws(() => injectNav('<html><body>no style block</body></html>'), /missing a <style> block or <body>/);
  assert.throws(() => injectNav('<style>x</style> no body'), /missing a <style> block or <body>/);
});

test('build-site refuses to wipe filesystem root', async () => {
  await assert.rejects(() => buildSite({ outDir: '/' }), /refusing to wipe unsafe output dir/);
});

test('build-site refuses to wipe repoRoot itself', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'pages-repo-'));
  try {
    await assert.rejects(
      () => buildSite({ repoRoot, outDir: repoRoot }),
      /refusing to wipe unsafe output dir/,
    );
    // Nothing deleted: dir still exists.
    await stat(repoRoot); // throws if missing
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
