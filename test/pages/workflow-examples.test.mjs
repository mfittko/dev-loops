import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite } from '../../scripts/pages/build-site.mjs';

const selected = ['conveyor-belt', 'collaborative-grilling', 'magentic-ui', 'open-swe', 'qa-wolf-mapping-ai', 'playwright-test-agents', 'meta-ach', 'evalgen', 'uxagent', 'conversational-ux-coanalysis', 'product-design-frontend', 'incident-response'];
test('publication selects only the twelve authorized workflow routes and assets without an archive', async () => {
  const out = await mkdtemp(join(tmpdir(), 'workflow-pages-'));
  try {
    await buildSite({ outDir: out });
    assert.deepEqual((await readdir(out)).filter(file => file.startsWith('workflow-') && file.endsWith('.html')).sort(), selected.map(slug => `workflow-${slug}.html`).sort());
    assert.deepEqual((await readdir(join(out, 'assets', 'workflow-models'))).sort(), selected.map(s => `${s}.mjs`).sort());
    assert.equal((await readdir(out)).includes('archive.html'), false);
  } finally { await rm(out, { recursive: true, force: true }); }
});
