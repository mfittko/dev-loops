import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSite, injectNav, ARTICLES, DECKS, NAV_LINKS } from '../../scripts/pages/build-site.mjs';

// A deck publishes under its outFile when set (the deep-dive article and deck
// share the source basename), else its source file name.
const deckOut = (d) => d.outFile ?? d.file;

test('build-site: index is the intro article, all resources published, nav links the others', async () => {
  const out = await mkdtemp(join(tmpdir(), 'pages-site-'));
  try {
    const result = await buildSite({ outDir: out });

    // Every deep-dive article and deck is published alongside the index.
    for (const r of ARTICLES) {
      await stat(join(out, r.file)); // throws if missing
    }
    for (const d of DECKS) {
      await stat(join(out, deckOut(d))); // throws if missing
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

    // Nav max-width must match the .wrap desktop width (72rem) so they align on desktop.
    // Regression guard for the issue-1040 fix: was incorrectly 64rem before.
    assert.ok(index.includes('max-width: 72rem'), 'site-nav uses max-width 72rem (aligned with .wrap)');
    assert.ok(!index.includes('max-width: 64rem'), 'site-nav must not use the old 64rem max-width');

    assert.deepEqual(
      result.files.sort(),
      ['index.html', ...ARTICLES.map((a) => a.file), ...DECKS.map((d) => deckOut(d))].sort(),
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
