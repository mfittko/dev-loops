import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSite, injectNav, resolveRepoUrl, ARTICLES, DECKS, NAV_LINKS, STATE_ATLAS } from '../../scripts/pages/build-site.mjs';

// A deck publishes under its outFile when set (the deep-dive article and deck
// share the source basename), else its source file name.
const deckOut = (d) => d.outFile ?? d.file;

const REPO_URL = 'https://github.com/mfittko/dev-loops';

// Extract the .site-nav-gh anchor's href and inner HTML so assertions bind to
// that specific anchor (not any <svg> that may appear in page content).
function ghAnchor(html) {
  const m = html.match(/<a class="site-nav-gh"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/s);
  assert.ok(m, 'page has a .site-nav-gh anchor');
  return { href: m[1], inner: m[2] };
}

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
    // Nav's GitHub anchor links the repo with an inline (CSP-safe) icon.
    const indexGh = ghAnchor(index);
    assert.equal(indexGh.href, REPO_URL, 'index GitHub nav anchor links the repo');
    assert.ok(indexGh.inner.includes('<svg'), 'index GitHub nav anchor uses an inline SVG icon');

    // Deep-dive articles also carry the nav so the set is navigable.
    const deep = await readFile(join(out, ARTICLES[0].file), 'utf8');
    assert.ok(deep.includes('class="site-nav"'), 'deep-dive article carries the nav bar');
    const deepGh = ghAnchor(deep);
    assert.equal(deepGh.href, REPO_URL, 'deep-dive GitHub nav anchor links the repo');
    assert.ok(deepGh.inner.includes('<svg'), 'deep-dive GitHub nav anchor uses an inline SVG icon');

    assert.deepEqual(
      result.files.sort(),
      [
        'index.html',
        ...ARTICLES.map((a) => a.file),
        ...DECKS.map((d) => deckOut(d)),
        STATE_ATLAS.file,
        'assets/mermaid.min.js',
      ].sort(),
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('build-site: state atlas is generated from the code tables, navigable, with the mermaid asset', async () => {
  const out = await mkdtemp(join(tmpdir(), 'pages-atlas-'));
  try {
    await buildSite({ outDir: out });

    // The vendored mermaid runtime is copied so the atlas page can load it.
    await stat(join(out, 'assets', 'mermaid.min.js')); // throws if missing

    const atlas = await readFile(join(out, STATE_ATLAS.file), 'utf8');

    // The atlas carries the shared nav (so it is part of the navigable set) and
    // references the mermaid asset rather than inlining it.
    assert.ok(atlas.includes('class="site-nav"'), 'atlas carries the nav bar');
    assert.ok(atlas.includes('src="assets/mermaid.min.js"'), 'atlas references the mermaid asset');

    // Mermaid sources emitted straight from the code tables — sentinel states
    // from each of the four core tables must appear verbatim. `round_cap_clean_fallback`
    // is a terminal copilot state, so it renders as a `-->` edge to [*].
    assert.ok(atlas.includes('round_cap_clean_fallback -->'), 'copilot STATE/TRANSITIONS rendered');
    assert.ok(atlas.includes('waiting_for_review_request'), 'reviewer REVIEWER_STATE rendered');
    assert.ok(atlas.includes('handoff_to_copilot_loop'), 'outer OUTER_STATE rendered');
    assert.ok(atlas.includes('copilot_pr_followup'), 'public dev-loop gate contract rendered');

    // The nav on the landing page links the atlas as a top-level menu item.
    const index = await readFile(join(out, 'index.html'), 'utf8');
    assert.ok(index.includes(`href="${STATE_ATLAS.file}"`), 'landing nav links the atlas');
    assert.ok(index.includes(`>${STATE_ATLAS.label}</a>`), 'landing nav shows the atlas label');
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('build-state-atlas: generator is pure and deterministic (identical bytes across builds)', async () => {
  const { buildStateAtlasHtml } = await import('../../scripts/pages/build-state-atlas.mjs');
  assert.equal(buildStateAtlasHtml(), buildStateAtlasHtml(), 'atlas HTML is byte-identical across calls');
});

test('build-state-atlas: fullscreen lightbox structure (one expand button per diagram, wired handler + CSS)', async () => {
  const { buildStateAtlasHtml } = await import('../../scripts/pages/build-state-atlas.mjs');
  const html = buildStateAtlasHtml();
  const diagrams = (html.match(/class="diagram"/g) ?? []).length;
  const buttons = (html.match(/class="expand" type="button" aria-label="View diagram fullscreen"/g) ?? []).length;
  assert.ok(diagrams > 0, 'atlas renders diagrams');
  assert.equal(buttons, diagrams, 'exactly one expand button per diagram');
  for (const token of ['requestFullscreen', 'fs-fallback', ':-webkit-full-screen', '.diagram .expand', 'fsInFlight']) {
    assert.ok(html.includes(token), `lightbox structure token missing: ${token}`);
  }
});

test('injectNav fails closed when a page lacks the expected structure', () => {
  assert.throws(() => injectNav('<html><body>no style block</body></html>', REPO_URL), /missing a <style> block or <body>/);
  assert.throws(() => injectNav('<style>x</style> no body', REPO_URL), /missing a <style> block or <body>/);
});

test('build-site refuses to wipe filesystem root', async () => {
  await assert.rejects(() => buildSite({ outDir: '/' }), /refusing to wipe unsafe output dir/);
});

test('resolveRepoUrl accepts string/object forms and throws a clear error when missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pages-repo-url-'));
  const write = (repository) =>
    writeFile(join(dir, 'package.json'), JSON.stringify(repository === undefined ? {} : { repository }), 'utf8');
  try {
    await write({ type: 'git', url: 'https://github.com/mfittko/dev-loops.git' });
    assert.equal(await resolveRepoUrl(dir), REPO_URL, 'object form: strips .git');

    await write('github:mfittko/dev-loops');
    assert.equal(await resolveRepoUrl(dir), REPO_URL, 'string shorthand normalizes to https URL');

    await write(undefined);
    await assert.rejects(() => resolveRepoUrl(dir), /has no repository\.url/, 'missing repository throws explicit error');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
