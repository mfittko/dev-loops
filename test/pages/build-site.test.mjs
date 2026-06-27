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
