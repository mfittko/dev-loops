#!/usr/bin/env node
// Assembles the GitHub Pages publishable dir deterministically. The landing
// page (index.html) is the "Introducing dev-loops" article; the deep-dive
// article and the presentation decks are published alongside it and reached through
// a shared navigation bar injected into the article pages. The HTML files under
// docs/ are the inputs here; site/ is assembled, never hand-maintained. Articles
// listed in render-article.mjs's RENDERED_ARTICLES are themselves derived from
// their markdown twin (edit the .md, then `npm run articles:render`); the rest
// are hand-maintained sources.
// Usage: node scripts/pages/build-site.mjs [--out <dir>] [--repo-root <dir>]
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep, parse as parsePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStateAtlasHtml } from './build-state-atlas.mjs';

const REPO_ROOT_DEFAULT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTPUT_MARKER = '.dev-loops-pages-output';
const OUTPUT_MARKER_CONTENT = 'owned by scripts/pages/build-site.mjs\n';

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
  {
    file: 'state-graph-surface.html',
    title: 'The State Graph Is the Surface',
    subtitle: 'Authoritative state, bounded loops, and human authority',
    description: 'How dev-loops turns lifecycle state and evidence into one governed control surface.',
    navLabel: 'State graph (deck)',
  },
];

// Resolve a deck's published filename: distinct outFile when set, else file.
const deckOut = (deck) => deck.outFile ?? deck.file;

export function assertUniquePublishTargets(targets) {
  const seen = new Set();
  for (const target of targets) {
    if (typeof target !== 'string' || target.length === 0 || target.includes('\\') || posix.isAbsolute(target)) {
      throw new Error(`unsafe Pages output target ${String(target)}`);
    }
    const normalized = posix.normalize(target);
    if (normalized !== target || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
      throw new Error(`unsafe Pages output target ${target}`);
    }
    for (const prior of seen) {
      if (prior === normalized || prior.startsWith(`${normalized}/`) || normalized.startsWith(`${prior}/`)) {
        throw new Error(`duplicate Pages output target ${target}`);
      }
    }
    seen.add(normalized);
  }
}

const isContained = (parent, candidate, pathApi = { relative, sep }) => {
  const rel = pathApi.relative(parent, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute?.(rel);
};

// Pure relationship guard, parameterized so Windows containment semantics are
// covered even when the test runner itself is POSIX.
export function assertSafeOutputRelationship(repoRoot, outDir, pathApi = { relative, sep, parse: parsePath, isAbsolute: () => false }) {
  const defaultOut = pathApi.join ? pathApi.join(repoRoot, 'site') : join(repoRoot, 'site');
  const isInsideRoot = isContained(repoRoot, outDir, pathApi);
  if (
    outDir === pathApi.parse(outDir).root ||
    outDir === repoRoot ||
    isContained(outDir, repoRoot, pathApi) ||
    (isInsideRoot && outDir !== defaultOut)
  ) {
    throw new Error(`refusing to wipe unsafe output dir ${outDir}`);
  }
}

async function physicalOutputPath(outDir) {
  let existing = outDir;
  for (;;) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  const physicalAncestor = await realpath(existing);
  return resolve(physicalAncestor, relative(existing, outDir));
}

async function prepareOutputDirectory(repoRoot, outDir) {
  assertSafeOutputRelationship(repoRoot, outDir, { relative, sep, parse: parsePath, isAbsolute: (value) => resolve(value) === value, join });

  // Re-evaluate after resolving the nearest existing ancestor. This catches an
  // intermediate symlink whose lexical spelling looks external but lands in the
  // repository (or above it).
  const [physicalRoot, physicalOut] = await Promise.all([realpath(repoRoot), physicalOutputPath(outDir)]);
  assertSafeOutputRelationship(physicalRoot, physicalOut, { relative, sep, parse: parsePath, isAbsolute: (value) => resolve(value) === value, join });

  const defaultOut = join(resolve(repoRoot), 'site');
  let outStat;
  try {
    outStat = await lstat(outDir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (outStat?.isSymbolicLink() || (outStat && !outStat.isDirectory())) {
    throw new Error(`refusing to wipe unsafe output dir ${outDir}`);
  }
  if (outStat && outDir !== defaultOut) {
    const entries = await readdir(outDir);
    if (entries.length > 0) {
      let marker;
      try {
        marker = await readFile(join(outDir, OUTPUT_MARKER), 'utf8');
      } catch {
        // A nonempty external directory is never assumed to belong to this build.
      }
      if (marker !== OUTPUT_MARKER_CONTENT) {
        throw new Error(`refusing to wipe unowned output dir ${outDir}`);
      }
    }
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, OUTPUT_MARKER), OUTPUT_MARKER_CONTENT, 'utf8');
}

// The State atlas: a generated page (site/state-atlas.html) rendering every
// dev-loops state machine as mermaid diagrams straight from the code's tables.
export const STATE_ATLAS = { file: 'state-atlas.html', label: 'State atlas' };

// The other resources linked from the navigation, in order.
export const NAV_LINKS = [
  ...ARTICLES.map((a) => ({ file: a.file, label: a.navLabel })),
  ...DECKS.map((d) => ({ file: deckOut(d), label: d.navLabel })),
  { file: STATE_ATLAS.file, label: STATE_ATLAS.label },
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
  const root = resolve(repoRoot);
  const out = outDir ? resolve(outDir) : join(root, 'site');
  const articlesDir = join(repoRoot, 'docs', 'articles');
  const decksDir = join(repoRoot, 'docs', 'presentations');

  // Guard: out is wiped before assembly. Within the repository, only the
  // generated site/ directory is a legal target. External output dirs must be
  // empty or carry this builder's ownership marker before they can be reused.
  const files = [
    'index.html',
    ...ARTICLES.map((a) => a.file),
    ...DECKS.map((d) => deckOut(d)),
    STATE_ATLAS.file,
    'assets/mermaid.min.js',
    OUTPUT_MARKER,
  ];
  assertUniquePublishTargets(files);

  // Reject obviously unsafe relationships before repository validation so
  // callers still receive the more specific output-safety error.
  assertSafeOutputRelationship(root, out, { relative, sep, parse: parsePath, isAbsolute: (value) => resolve(value) === value, join });

  // Establish that repoRoot identifies a repository before granting its site/
  // directory privileged output status. A mistyped root must fail without
  // deleting an unrelated, nonempty site/ directory.
  const repoUrl = await resolveRepoUrl(root);

  await prepareOutputDirectory(root, out);

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

  // State atlas: generated from the core state tables at build time, then given
  // the same shared nav as the article pages so it can never drift from the code.
  await writeFile(join(out, STATE_ATLAS.file), injectNav(buildStateAtlasHtml(), repoUrl), 'utf8');

  // Vendored mermaid runtime the atlas page references (Pages has no CSP, so we
  // load it as an external asset rather than inlining ~3MB into the page).
  const mermaidSrc = join(repoRoot, 'scripts', 'loop', 'inspect-run-viewer', 'vendor', 'mermaid.min.js');
  await mkdir(join(out, 'assets'), { recursive: true });
  await cp(mermaidSrc, join(out, 'assets', 'mermaid.min.js'));

  return {
    out,
    files,
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
