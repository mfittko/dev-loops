#!/usr/bin/env node
// Render docs/articles/*.html from their markdown twin. The markdown is the
// single source of truth for article CONTENT; the HTML twin is a derived
// artifact assembled from scripts/pages/article-shell.html (the design system:
// head, CSP meta, and the style tokens build-site.mjs's nav injection depends
// on) plus a deterministic transform of the markdown body.
//
// The transform is deliberately a fail-closed subset, not a general markdown
// engine: headings, paragraphs, bullet lists, fenced code blocks, and the
// inline set (**bold**, *em*, `code`, [links]) used by the articles. Anything
// it does not recognize throws, so an unsupported construct becomes a build
// error instead of silently mangled prose. Article-specific conventions:
//
//   - Frontmatter `title` fills the shell <title> and hero <h1>; frontmatter
//     `heroLede` fills the hero card's lede line.
//   - A bullet list between `<!-- metrics:start -->` and `<!-- metrics:end -->`
//     renders as the .metrics card row; each item must be `**<num>** <label>`.
//   - Every h2 gets a GitHub-style slug id, so in-page `#anchors` written in
//     the markdown resolve in both renderings.
//   - The final h2 section renders as the boxed .deeper outro behind an
//     <hr class="rule" />.
//   - Relative links to `.md` files are rewritten to their `.html` twins.
//   - `#`-to-end-of-line comments inside fenced code render in .cm spans.
//
// Usage:
//   node scripts/pages/render-article.mjs           # rewrite the HTML twin(s)
//   node scripts/pages/render-article.mjs --check   # exit 1 if any twin is stale

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ARTICLES_DIR = path.join(REPO_ROOT, "docs", "articles");
const SHELL_PATH = path.join(REPO_ROOT, "scripts", "pages", "article-shell.html");

// Rendered articles: markdown source → derived HTML twin. The deep-dive
// article predates this renderer and stays hand-maintained until migrated.
export const RENDERED_ARTICLES = [
  { md: "introducing-dev-loops.md", html: "introducing-dev-loops.html" },
];

const escapeHtml = (s) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");

/** Inline markdown → HTML: escape first, then `code`, **bold**, *em*, [links]. */
function renderInline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const target = href.replace(/^(\.{1,2}\/[^)#]*)\.md(#[^)]*)?$/, "$1.html$2");
    return `<a href="${target}">${label}</a>`;
  });
  return out;
}

/** Wrap `#`-to-end-of-line comments of an escaped code block in .cm spans. */
const markCodeComments = (escaped) =>
  escaped
    .split("\n")
    .map((line) => line.replace(/(^|\s)(#.*)$/, '$1<span class="cm">$2</span>'))
    .join("\n");

/** Parse the markdown body into a flat block list. Throws on unknown syntax. */
function parseBlocks(body) {
  const lines = body.split("\n");
  const blocks = [];
  let metricsPending = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (line.trim() === "<!-- metrics:start -->") { metricsPending = true; continue; }
    if (line.trim() === "<!-- metrics:end -->") { metricsPending = false; continue; }
    if (line.startsWith("```")) {
      const fence = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) fence.push(lines[i]);
      if (i >= lines.length) throw new Error("unterminated code fence");
      blocks.push({ type: "code", text: fence.join("\n") });
    } else if (line.startsWith("## ")) {
      blocks.push({ type: "h2", text: line.slice(3).trim() });
    } else if (line.startsWith("# ")) {
      blocks.push({ type: "h1", text: line.slice(2).trim() });
    } else if (line.startsWith("- ")) {
      const items = [];
      for (; i < lines.length && lines[i].startsWith("- "); i++) items.push(lines[i].slice(2).trim());
      i--;
      blocks.push({ type: metricsPending ? "metrics" : "list", items });
    } else if (/^[#>|]/.test(line) || line.startsWith("  ")) {
      throw new Error(`unsupported markdown construct at line ${i + 1}: ${JSON.stringify(line)}`);
    } else {
      const para = [];
      for (; i < lines.length && lines[i].trim() !== "" && !/^(#|-|```|<!--)/.test(lines[i]); i++) para.push(lines[i]);
      i--;
      blocks.push({ type: "p", text: para.join(" ") });
    }
  }
  return blocks;
}

function renderMetrics(items) {
  const cards = items.map((item) => {
    const m = item.match(/^\*\*([^*]+)\*\*\s+(.*)$/);
    if (!m) throw new Error(`metrics item must be "**<num>** <label>": ${JSON.stringify(item)}`);
    return `    <div class="metric" role="listitem"><div class="num">${renderInline(m[1])}</div><div class="lab">${renderInline(m[2])}</div></div>`;
  });
  return `  <div class="metrics" role="list">\n${cards.join("\n")}\n  </div>`;
}

/**
 * Render one article's markdown source into the full HTML page.
 * @param {string} mdSource - full markdown file contents including frontmatter
 * @param {string} shell - article-shell.html template contents
 * @returns {string}
 */
export function renderArticleHtml(mdSource, shell) {
  const fm = mdSource.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) throw new Error("article markdown must start with YAML frontmatter");
  const meta = parseYaml(fm[1]);
  if (!meta?.title || !meta?.heroLede) {
    throw new Error("article frontmatter must set title and heroLede");
  }

  const blocks = parseBlocks(mdSource.slice(fm[0].length));
  if (blocks[0]?.type !== "h1" || blocks[0].text !== meta.title) {
    throw new Error("article body must open with an h1 matching the frontmatter title");
  }

  const lastH2 = blocks.reduce((last, b, i) => (b.type === "h2" ? i : last), -1);
  const out = [];
  out.push(`  <header class="hero-card">
    <p class="kicker">dev-loops</p>
    <h1>${renderInline(meta.title)}</h1>
    <p class="lede">${renderInline(meta.heroLede)}</p>
  </header>`);

  let inDeeper = false;
  for (const [i, block] of blocks.entries()) {
    if (block.type === "h1") continue;
    if (block.type === "h2") {
      if (i === lastH2) {
        out.push(`  <hr class="rule" />`, ``, `  <section class="deeper">`);
        out.push(`    <h2 id="${slugify(block.text)}">${renderInline(block.text)}</h2>`);
        inDeeper = true;
      } else {
        out.push(`  <h2 id="${slugify(block.text)}">${renderInline(block.text)}</h2>`);
      }
    } else if (block.type === "p") {
      out.push(inDeeper ? `    <p>${renderInline(block.text)}</p>` : `  <p>${renderInline(block.text)}</p>`);
    } else if (block.type === "list") {
      out.push(`  <ul>\n${block.items.map((it) => `    <li>${renderInline(it)}</li>`).join("\n")}\n  </ul>`);
    } else if (block.type === "metrics") {
      out.push(renderMetrics(block.items));
    } else if (block.type === "code") {
      out.push(`  <pre><code>${markCodeComments(escapeHtml(block.text))}</code></pre>`);
    }
  }
  if (inDeeper) out.push(`  </section>`);

  const generated = `<!-- GENERATED from docs/articles/${meta.sourceBasename} by scripts/pages/render-article.mjs — do not edit; edit the markdown and regenerate. -->`;
  return (
    shell.replace("{{TITLE}}", escapeHtml(meta.title)).replace("{{GENERATED}}", generated) +
    `<body>\n<div class="wrap">\n<article class="article">\n\n${out.join("\n\n")}\n\n</article>\n</div>\n</body>\n</html>\n`
  );
}

async function renderAll() {
  const shell = await readFile(SHELL_PATH, "utf8");
  const results = [];
  for (const { md, html } of RENDERED_ARTICLES) {
    const mdSource = await readFile(path.join(ARTICLES_DIR, md), "utf8");
    // Thread the source basename through frontmatter meta for the marker line.
    const rendered = renderArticleHtml(
      mdSource.replace(/^---\n/, `---\nsourceBasename: ${md}\n`),
      shell
    );
    results.push({ md, html, rendered });
  }
  return results;
}

async function main() {
  const check = process.argv.includes("--check");
  for (const { md, html, rendered } of await renderAll()) {
    const htmlPath = path.join(ARTICLES_DIR, html);
    if (check) {
      let existing = null;
      try {
        existing = await readFile(htmlPath, "utf8");
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
      }
      if (existing !== rendered) {
        console.error(
          `docs/articles/${html} is stale relative to ${md} — regenerate with \`node scripts/pages/render-article.mjs\``
        );
        process.exit(1);
      }
      console.log(`docs/articles/${html} is up to date`);
    } else {
      await writeFile(htmlPath, rendered, "utf8");
      console.log(`rendered docs/articles/${html} from ${md}`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
