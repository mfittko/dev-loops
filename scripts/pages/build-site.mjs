#!/usr/bin/env node
// Assembles the GitHub Pages publishable dir deterministically: copies the
// self-contained deck HTML renders and generates an index linking them.
// The deck HTML files are the source of truth; site/ is assembled, never
// hand-maintained. Usage: node scripts/pages/build-site.mjs [--out <dir>] [--repo-root <dir>]
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, parse as parsePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT_DEFAULT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The decks to publish. file is relative to docs/presentations/.
export const DECKS = [
  {
    file: 'applied-dev-loops.html',
    title: 'Applied dev-loops',
    subtitle: 'Eliminating Coordination Delay',
    description: 'How a coordination runtime turns review and merge handoffs into a parallel, fail-closed pipeline.',
  },
  {
    file: 'process-observability.html',
    title: 'Process Observability',
    subtitle: 'Make the Waiting Visible',
    description: 'Why measuring how long work waits — not how fast you write code — is what cuts delivery delay.',
  },
];

function renderIndex(decks) {
  const cards = decks
    .map(
      (d) => `      <a class="card" href="${d.file}">
        <span class="card-title">${d.title}</span>
        <span class="card-subtitle">${d.subtitle}</span>
        <span class="card-desc">${d.description}</span>
      </a>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'" />
<title>dev-loops: Presentation Decks</title>
<style>
  :root {
    --ground-1: #08101f;
    --ground-2: #0b1220;
    --ground-3: #0f172a;
    --ink: #e5e7eb;
    --heading: #f8fafc;
    --copy: #cbd5e1;
    --accent: #a78bfa;
    --accent-soft: #ddd6fe;
    --kicker: #93c5fd;
    --card-border: rgba(148, 163, 184, 0.18);
    --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "Helvetica Neue", sans-serif;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    min-height: 100vh;
    font-family: var(--font);
    color: var(--ink);
    background:
      radial-gradient(circle at 85% 12%, rgba(139, 92, 246, 0.24), transparent 24%),
      radial-gradient(circle at 15% 8%, rgba(59, 130, 246, 0.18), transparent 20%),
      linear-gradient(180deg, var(--ground-1) 0%, var(--ground-2) 42%, var(--ground-3) 100%);
    -webkit-text-size-adjust: 100%;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: clamp(2rem, 6vh, 4rem) clamp(1.25rem, 5vw, 3rem);
  }

  main {
    width: 100%;
    max-width: 64rem;
    margin: 0 auto;
  }

  .kicker {
    font-size: 0.8rem;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--kicker);
    margin: 0 0 0.75rem;
  }

  h1 {
    color: var(--heading);
    font-size: clamp(1.9rem, 5vw, 3rem);
    line-height: 1.05;
    margin: 0 0 0.75rem;
  }

  .lede {
    color: var(--copy);
    font-size: clamp(1rem, 2.2vw, 1.2rem);
    margin: 0 0 2.5rem;
    max-width: 44rem;
  }

  .cards {
    display: grid;
    gap: 1.25rem;
    grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    text-decoration: none;
    padding: 1.5rem;
    border: 1px solid var(--card-border);
    border-radius: 14px;
    background: rgba(15, 23, 42, 0.55);
    transition: border-color 120ms ease, transform 120ms ease;
  }

  .card:hover,
  .card:focus-visible {
    border-color: var(--accent);
    transform: translateY(-2px);
    outline: none;
  }

  .card-title {
    color: var(--heading);
    font-size: 1.3rem;
    font-weight: 600;
  }

  .card-subtitle {
    color: var(--accent-soft);
    font-size: 0.95rem;
  }

  .card-desc {
    color: var(--copy);
    font-size: 0.9rem;
    margin-top: 0.35rem;
    line-height: 1.5;
  }

  @media (prefers-reduced-motion: reduce) {
    .card { transition: none; }
    .card:hover,
    .card:focus-visible { transform: none; }
  }
</style>
</head>
<body>
  <main>
    <p class="kicker">dev-loops</p>
    <h1>Presentation Decks</h1>
    <p class="lede">Self-contained talks on cutting coordination delay and making process latency observable.</p>
    <nav class="cards">
${cards}
    </nav>
  </main>
</body>
</html>
`;
}

export async function buildSite({ repoRoot = REPO_ROOT_DEFAULT, outDir } = {}) {
  const out = outDir ? resolve(outDir) : join(repoRoot, 'site');
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

  for (const deck of DECKS) {
    await cp(join(decksDir, deck.file), join(out, deck.file));
  }
  await writeFile(join(out, 'index.html'), renderIndex(DECKS), 'utf8');

  return { out, files: ['index.html', ...DECKS.map((d) => d.file)] };
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
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
