import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSite, DECKS } from '../../scripts/pages/build-site.mjs';

test('build-site assembles index + both deck files, index links both decks', async () => {
  const out = await mkdtemp(join(tmpdir(), 'pages-site-'));
  try {
    const result = await buildSite({ outDir: out });

    for (const deck of DECKS) {
      await stat(join(out, deck.file)); // throws if missing
    }
    const index = await readFile(join(out, 'index.html'), 'utf8');
    for (const deck of DECKS) {
      assert.ok(index.includes(`href="${deck.file}"`), `index links ${deck.file}`);
      assert.ok(index.includes(deck.title), `index shows ${deck.title}`);
    }
    assert.deepEqual(result.files.sort(), ['index.html', ...DECKS.map((d) => d.file)].sort());
  } finally {
    await rm(out, { recursive: true, force: true });
  }
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
