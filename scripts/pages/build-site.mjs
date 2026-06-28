#!/usr/bin/env node
// Assembles the GitHub Pages publishable dir deterministically. The landing
// page (index.html) is the "Introducing dev-loops" article; the two deep-dive
// articles and the two decks are published alongside it and reached through a
// shared navigation bar injected into the article pages. The source HTML files
// under docs/ are the source of truth; site/ is assembled, never hand-maintained.
// Usage: node scripts/pages/build-site.mjs [--out <dir>] [--repo-root <dir>]
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, parse as parsePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT_DEFAULT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The landing page: the intro article, published as index.html. file is
// relative to docs/articles/.
export const LANDING = { file: 'introducing-dev-loops.html' };

// Deep-dive articles published alongside the landing page. file is relative to
// docs/articles/; navLabel is how the nav refers to them.
export const ARTICLES = [
  { file: 'eliminating-coordination-delay.html', navLabel: 'Coordination Delay' },
  { file: 'make-the-waiting-visible.html', navLabel: 'Make the Waiting Visible' },
];

// The decks to publish. file is relative to docs/presentations/.
export const DECKS = [
  {
    file: 'introducing-dev-loops.html',
    title: 'Introducing dev-loops',
    subtitle: 'A coordination runtime for AI-assisted development',
    description: 'The concept, the data behind it, and how to run the loop on your own project.',
    navLabel: 'Intro (deck)',
  },
  {
    file: 'applied-dev-loops.html',
    title: 'Applied dev-loops',
    subtitle: 'Eliminating Coordination Delay',
    description: 'How a coordination runtime turns review and merge handoffs into a parallel, fail-closed pipeline.',
    navLabel: 'Applied (deck)',
  },
  {
    file: 'process-observability.html',
    title: 'Process Observability',
    subtitle: 'Make the Waiting Visible',
    description: 'Why measuring how long work waits — not how fast you write code — is what cuts delivery delay.',
    navLabel: 'Observability (deck)',
  },
];

// The other resources linked from the navigation, in order.
export const NAV_LINKS = [
  ...ARTICLES.map((a) => ({ file: a.file, label: a.navLabel })),
  ...DECKS.map((d) => ({ file: d.file, label: d.navLabel })),
];

// Nav styling, appended to each article page's own <style> block so it reuses
// the article design-system variables (--heading/--kicker/--accent-soft).
const NAV_CSS = `
  .site-nav { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem 1.1rem; max-width: 64rem; margin: 0 auto; padding: 0.9rem clamp(1.1rem, 5vw, 2rem); border-bottom: 1px solid rgba(148, 163, 184, 0.16); }
  .site-nav-brand { font-weight: 700; letter-spacing: -0.01em; color: var(--heading); text-decoration: none; border: 0; margin-right: auto; }
  .site-nav-links { display: flex; flex-wrap: wrap; gap: 0.5rem 1.1rem; }
  .site-nav a { color: var(--kicker); text-decoration: none; font-size: 0.9rem; border: 0; }
  .site-nav a:hover { color: var(--accent-soft); }`;

function navMarkup() {
  const links = NAV_LINKS.map((l) => `        <a href="${l.file}">${l.label}</a>`).join('\n');
  return `<nav class="site-nav" aria-label="dev-loops resources">
      <a class="site-nav-brand" href="index.html">dev-loops</a>
      <div class="site-nav-links">
${links}
      </div>
    </nav>`;
}

// Inject the shared nav into an article page: nav CSS before </style>, nav
// markup right after <body>. Idempotent enough for assembly (each source file
// is read once). Throws if the page lacks the expected anchors so a structural
// drift fails the build rather than publishing an un-navigable page.
export function injectNav(html) {
  if (!html.includes('</style>') || !/<body[^>]*>/.test(html)) {
    throw new Error('cannot inject nav: page is missing a <style> block or <body> tag');
  }
  return html
    .replace('</style>', `${NAV_CSS}\n</style>`)
    .replace(/<body([^>]*)>/, `<body$1>\n    ${navMarkup()}`);
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

  // Landing page: the intro article, navigable, published as index.html.
  const landingHtml = await readFile(join(articlesDir, LANDING.file), 'utf8');
  await writeFile(join(out, 'index.html'), injectNav(landingHtml), 'utf8');

  // Deep-dive articles: published with the same nav so the set is navigable.
  for (const article of ARTICLES) {
    const html = await readFile(join(articlesDir, article.file), 'utf8');
    await writeFile(join(out, article.file), injectNav(html), 'utf8');
  }

  // Decks: self-contained slide renders, copied as-is (no nav injection).
  for (const deck of DECKS) {
    await cp(join(decksDir, deck.file), join(out, deck.file));
  }

  return {
    out,
    files: ['index.html', ...ARTICLES.map((a) => a.file), ...DECKS.map((d) => d.file)],
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
