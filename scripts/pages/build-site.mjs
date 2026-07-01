#!/usr/bin/env node
// Assembles the GitHub Pages publishable dir deterministically. The landing
// page (index.html) is the "Introducing dev-loops" article; the deep-dive
// article and the deep-dive deck are published alongside it and reached through
// a shared navigation bar injected into the article pages. The source HTML files
// under docs/ are the source of truth; site/ is assembled, never hand-maintained.
// Usage: node scripts/pages/build-site.mjs [--out <dir>] [--repo-root <dir>]
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, parse as parsePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT_DEFAULT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The landing page: the intro article, published as index.html. file is
// relative to docs/articles/.
export const LANDING = { file: 'introducing-dev-loops.html' };

// The deep-dive article published alongside the landing page. file is relative
// to docs/articles/; navLabel is how the nav refers to it.
export const ARTICLES = [
  { file: 'dev-loops-deep-dive.html', navLabel: 'Deep dive' },
];

// The decks to publish. file is relative to docs/presentations/; outFile is the
// published name (defaults to file). The deep-dive article and deck share the
// source basename dev-loops-deep-dive.html under different docs/ dirs, so the
// deck publishes under a distinct name to avoid clobbering the article in site/.
export const DECKS = [
  {
    file: 'introducing-dev-loops.html',
    title: 'Introducing dev-loops',
    subtitle: 'A coordination runtime for AI-assisted development',
    description: 'The concept, the data behind it, and how to run the loop on your own project.',
    navLabel: 'Intro (deck)',
  },
  {
    file: 'dev-loops-deep-dive.html',
    outFile: 'dev-loops-deep-dive-deck.html',
    title: 'dev-loops: A Deep Dive',
    subtitle: 'Coordination delay and the waiting between actions',
    description: 'How explicit handoffs on a state graph and measuring the wait between actions cut delivery delay.',
    navLabel: 'Deep dive (deck)',
  },
];

// Resolve a deck's published filename: distinct outFile when set, else file.
const deckOut = (deck) => deck.outFile ?? deck.file;

// The other resources linked from the navigation, in order.
export const NAV_LINKS = [
  ...ARTICLES.map((a) => ({ file: a.file, label: a.navLabel })),
  ...DECKS.map((d) => ({ file: deckOut(d), label: d.navLabel })),
];

// Nav styling, appended to each article page's own <style> block so it reuses
// the article design-system variables (--heading/--kicker/--accent-soft).
const NAV_CSS = `
  .site-nav { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem 1.1rem; max-width: 48rem; margin: 0 auto; padding: 0.9rem clamp(1.1rem, 5vw, 2rem); border-bottom: 1px solid rgba(148, 163, 184, 0.16); }
  @media (min-width: 900px) { .site-nav { max-width: 56rem; } }
  .site-nav-brand { font-weight: 700; letter-spacing: -0.01em; color: var(--heading); text-decoration: none; border: 0; margin-right: auto; }
  .site-nav-links { display: flex; flex-wrap: wrap; gap: 0.5rem 1.1rem; }
  .site-nav a { color: var(--kicker); text-decoration: none; font-size: 0.9rem; border: 0; }
  .site-nav a:hover { color: var(--accent-soft); }
  .site-nav-gh { display: inline-flex; align-items: center; }
  .site-nav-gh svg { width: 1.125rem; height: 1.125rem; fill: currentColor; display: block; }`;

// The repository the site links to from its nav. Derived from the effective
// repoRoot's package.json repository.url (single source of truth) so a repo
// rename/move updates the nav link too, rather than drifting from a hardcoded
// copy. Resolved inside buildSite from its repoRoot param (not at module load)
// so --repo-root / buildSite({ repoRoot }) reads the right package.json and no
// I/O runs merely on import. The '.git' suffix is stripped for the web URL.
// npm's `repository` field may be a string ("github:owner/repo" or a full URL)
// or an object { type, url }. Accept both; fail with an explicit, actionable
// message when neither yields a URL, rather than an implicit TypeError.
export async function resolveRepoUrl(repoRoot) {
  const { repository } = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (!raw) {
    throw new Error(`cannot resolve repo URL: package.json at ${repoRoot} has no repository.url`);
  }
  return raw
    .replace(/^github:/, 'https://github.com/')
    .replace(/\.git$/, '');
}
// Inline SVG (GitHub octicon mark) so it renders under the page's strict CSP
// (img-src is data:-only; no external icon).
const GITHUB_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>';

function navMarkup(repoUrl) {
  const links = NAV_LINKS.map((l) => `        <a href="${l.file}">${l.label}</a>`).join('\n');
  return `<nav class="site-nav" aria-label="dev-loops resources">
      <a class="site-nav-brand" href="index.html">dev-loops</a>
      <div class="site-nav-links">
${links}
        <a class="site-nav-gh" href="${repoUrl}" aria-label="dev-loops on GitHub">${GITHUB_ICON}</a>
      </div>
    </nav>`;
}

// Inject the shared nav into an article page: nav CSS before </style>, nav
// markup right after <body>. Idempotent enough for assembly (each source file
// is read once). Throws if the page lacks the expected anchors so a structural
// drift fails the build rather than publishing an un-navigable page.
export function injectNav(html, repoUrl) {
  if (!html.includes('</style>') || !/<body[^>]*>/.test(html)) {
    throw new Error('cannot inject nav: page is missing a <style> block or <body> tag');
  }
  return html
    .replace('</style>', `${NAV_CSS}\n</style>`)
    .replace(/<body([^>]*)>/, `<body$1>\n    ${navMarkup(repoUrl)}`);
}

export async function buildSite({ repoRoot = REPO_ROOT_DEFAULT, outDir } = {}) {
  const out = outDir ? resolve(outDir) : join(repoRoot, 'site');
  const articlesDir = join(repoRoot, 'docs', 'articles');
  const decksDir = join(repoRoot, 'docs', 'presentations');

  // Guard: out is wiped before assembly. Refuse paths that would nuke the
  // filesystem root, the repo itself, or an ancestor of the repo.
  const root = resolve(repoRoot);
  const isAncestorOf = (a, b) => b === a || b.startsWith(a + '/');
  if (out === parsePath(out).root || out === root || isAncestorOf(out, root)) {
    throw new Error(`refusing to wipe unsafe output dir ${out}`);
  }

  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const repoUrl = await resolveRepoUrl(repoRoot);

  // Landing page: the intro article, navigable, published as index.html.
  const landingHtml = await readFile(join(articlesDir, LANDING.file), 'utf8');
  await writeFile(join(out, 'index.html'), injectNav(landingHtml, repoUrl), 'utf8');

  // Deep-dive article: published with the same nav so the set is navigable.
  for (const article of ARTICLES) {
    const html = await readFile(join(articlesDir, article.file), 'utf8');
    await writeFile(join(out, article.file), injectNav(html, repoUrl), 'utf8');
  }

  // Decks: self-contained slide renders, copied as-is (no nav injection).
  for (const deck of DECKS) {
    await cp(join(decksDir, deck.file), join(out, deckOut(deck)));
  }

  return {
    out,
    files: ['index.html', ...ARTICLES.map((a) => a.file), ...DECKS.map((d) => deckOut(d))],
  };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const result = await buildSite({
    repoRoot: getArg('--repo-root') ? resolve(getArg('--repo-root')) : undefined,
    outDir: getArg('--out'),
  });
  console.log(`Built site at ${result.out}: ${result.files.join(', ')}`);
}
