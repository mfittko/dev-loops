#!/usr/bin/env node
// Render docs/articles/*.html from their markdown twin. The markdown is the
// single source of truth for article CONTENT; the HTML twin is a derived
// artifact assembled from scripts/pages/article-shell.html (the design system:
// head, CSP meta, and the style tokens build-site.mjs's nav injection depends
// on) plus a deterministic transform of the markdown body.
//
// The transform is deliberately a fail-closed subset, not a general markdown
// engine: headings (h1-h3), paragraphs, bullet lists, blockquotes, fenced code
// blocks, mermaid diagram figures, and the inline set (**bold**, *em*, `code`,
// [links]) used by the articles. Anything it does not recognize throws, so an
// unsupported construct becomes a build error instead of silently mangled
// prose. Article-specific conventions:
//
//   - Frontmatter `title` fills the shell <title> and hero <h1>; frontmatter
//     `heroLede` fills the hero card's lede line.
//   - A bullet list between `<!-- metrics:start -->` and `<!-- metrics:end -->`
//     renders as the .metrics card row; each item must be `**<num>** <label>`.
//   - Every h2 gets a GitHub-style slug id, so in-page `#anchors` written in
//     the markdown resolve in both renderings. Duplicate h2 slugs throw.
//   - The final h2 section renders as the boxed .deeper outro behind an
//     <hr class="rule" />, unless frontmatter sets `outro: closer` — then the
//     last h2 renders as a plain section and the article's final paragraph
//     gets a `.closer` class instead.
//   - A non-first h1 must be a `Part N — Title` divider, rendered as a
//     `.part` group above the following h2s.
//   - A ```mermaid fence must be followed by a single-line italic
//     `*Diagram N — Title. …*` caption and then a `<!-- figure … -->` region;
//     the mermaid source is dropped and the region's inner HTML is emitted
//     verbatim inside a `<figure>` (the design-system markup a mermaid
//     renderer can't reproduce). The region must not contain nested HTML
//     comments or a `<script` element (case-insensitive).
//   - A run of `> `-prefixed lines renders as one <blockquote> with inline
//     rendering (including link rewrites) applied.
//   - Relative `./`- or `../`-prefixed links to `.md` files are rewritten to
//     their `.html` twins.
//   - `#`-to-end-of-line comments inside fenced code render in .cm spans.
//
// Usage:
//   node scripts/pages/render-article.mjs           # rewrite the HTML twin(s)
//   node scripts/pages/render-article.mjs --check   # exit 1 if any twin is stale

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { isDirectCliRun } from "../_core-helpers.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ARTICLES_DIR = path.join(REPO_ROOT, "docs", "articles");
const SHELL_PATH = path.join(REPO_ROOT, "scripts", "pages", "article-shell.html");

// Rendered articles: markdown source → derived HTML twin.
export const RENDERED_ARTICLES = [
  { md: "introducing-dev-loops.md", html: "introducing-dev-loops.html" },
];

// Quote-escaping matters even under the strict CSP: rendered text is also
// interpolated into href="" attributes, where a bare quote breaks out.
const escapeHtml = (s) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

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

const DIAGRAM_CAPTION_RE = /^\*Diagram \d+ [—-] .+\*$/;
const PART_HEADING_RE = /^Part (\d+) [—-] (.+)$/;

/**
 * Parse the diagram caption + `<!-- figure … -->` region that must follow a
 * ```mermaid fence. `startIndex` is the line right after the closing fence.
 * Blank lines are tolerated (zero or more) both before the caption and before
 * the figure opener. The region's terminator is an exact-line `-->`: any
 * other line inside the region carrying `<!--` or `-->` throws, so a nested
 * HTML comment fails the build instead of silently truncating the region.
 */
function parseDiagramRegion(lines, startIndex) {
  let j = startIndex;
  while (j < lines.length && lines[j].trim() === "") j++;
  if (j >= lines.length || !DIAGRAM_CAPTION_RE.test(lines[j].trim())) {
    throw new Error(`mermaid fence must be followed by a "*Diagram N — Title. …*" caption at line ${j + 1}`);
  }
  const caption = lines[j].trim().slice(1, -1);
  j++;
  while (j < lines.length && lines[j].trim() === "") j++;
  if (j >= lines.length || lines[j].trim() !== "<!-- figure") {
    throw new Error(`diagram caption must be followed by a "<!-- figure" region at line ${j + 1}`);
  }
  j++;
  const inner = [];
  let closed = false;
  for (; j < lines.length; j++) {
    if (lines[j].trim() === "-->") { closed = true; j++; break; }
    if (lines[j].includes("<!--") || lines[j].includes("-->")) {
      throw new Error(`figure region must not contain nested HTML comments at line ${j + 1}: ${JSON.stringify(lines[j].trim())}`);
    }
    inner.push(lines[j]);
  }
  if (!closed) throw new Error("unterminated figure region: <!-- figure has no matching -->");
  const innerHtml = inner.join("\n");
  if (/<script/i.test(innerHtml)) {
    throw new Error("figure region must not contain a <script> element");
  }
  return { caption, inner: innerHtml, nextIndex: j };
}

/** Parse the markdown body into a flat block list. Throws on unknown syntax. */
function parseBlocks(body) {
  const lines = body.split("\n");
  const blocks = [];
  let metricsPending = false;
  let seenH1 = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (line.trim() === "<!-- metrics:start -->") { metricsPending = true; continue; }
    if (line.trim() === "<!-- metrics:end -->") { metricsPending = false; continue; }
    // Any other HTML comment must fail closed: the paragraph collector treats
    // `<!--` as a block boundary, so an unrecognized comment line would
    // otherwise re-enter the loop at the same index forever. `<!-- figure`
    // regions are only ever consumed from inside the mermaid-fence branch
    // below, so a stray one here still hits this throw.
    if (line.trimStart().startsWith("<!--")) {
      throw new Error(`unsupported HTML comment at line ${i + 1}: ${JSON.stringify(line.trim())} — only the metrics markers and diagram figure regions are recognized`);
    }
    if (line.startsWith("```")) {
      const info = line.slice(3).trim();
      const fence = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) fence.push(lines[i]);
      if (i >= lines.length) throw new Error("unterminated code fence");
      if (info === "mermaid") {
        const { caption, inner, nextIndex } = parseDiagramRegion(lines, i + 1);
        blocks.push({ type: "diagram", caption, inner });
        i = nextIndex - 1;
      } else {
        blocks.push({ type: "code", text: fence.join("\n") });
      }
    } else if (line.startsWith("### ")) {
      blocks.push({ type: "h3", text: line.slice(4).trim() });
    } else if (line.startsWith("## ")) {
      blocks.push({ type: "h2", text: line.slice(3).trim() });
    } else if (line.startsWith("# ")) {
      const text = line.slice(2).trim();
      if (!seenH1) {
        seenH1 = true;
        blocks.push({ type: "h1", text });
      } else {
        const part = text.match(PART_HEADING_RE);
        if (!part) {
          throw new Error(`non-first h1 must be a "Part N — Title" divider at line ${i + 1}: ${JSON.stringify(text)}`);
        }
        blocks.push({ type: "part", num: part[1], title: part[2] });
      }
    } else if (line.startsWith("> ")) {
      const quote = [];
      for (; i < lines.length && lines[i].startsWith("> "); i++) quote.push(lines[i].slice(2));
      i--;
      blocks.push({ type: "blockquote", text: quote.join(" ") });
    } else if (line.startsWith("- ")) {
      const items = [];
      for (; i < lines.length && lines[i].startsWith("- "); i++) items.push(lines[i].slice(2).trim());
      i--;
      blocks.push({ type: metricsPending ? "metrics" : "list", items });
    } else if (/^[#>|]/.test(line) || line.startsWith("  ")) {
      throw new Error(`unsupported markdown construct at line ${i + 1}: ${JSON.stringify(line)}`);
    } else {
      const para = [];
      for (; i < lines.length && lines[i].trim() !== "" && !/^(#|-|>|```|<!--)/.test(lines[i]); i++) para.push(lines[i]);
      i--;
      blocks.push({ type: "p", text: para.join(" ") });
    }
  }
  if (metricsPending) {
    throw new Error("unterminated metrics block: <!-- metrics:start --> has no matching <!-- metrics:end -->");
  }
  return blocks;
}

/** Diagram figcaption: bold-split the caption's first sentence from the rest. */
function renderDiagramCaption(caption) {
  const dot = caption.indexOf(". ");
  const head = dot === -1 ? caption : caption.slice(0, dot + 1);
  const rest = dot === -1 ? "" : caption.slice(dot + 2);
  return rest ? `<b>${renderInline(head)}</b> ${renderInline(rest)}` : `<b>${renderInline(head)}</b>`;
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
 * @param {string} sourceBasename - the markdown file's basename, for the GENERATED marker
 * @returns {string}
 */
export function renderArticleHtml(mdSource, shell, sourceBasename) {
  if (!sourceBasename) throw new Error("renderArticleHtml requires the markdown sourceBasename");
  const fm = mdSource.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) throw new Error("article markdown must start with YAML frontmatter");
  const meta = parseYaml(fm[1]);
  if (!meta?.title || !meta?.heroLede) {
    throw new Error("article frontmatter must set title and heroLede");
  }
  const outro = meta.outro ?? "deeper";
  if (outro !== "deeper" && outro !== "closer") {
    throw new Error(`unknown frontmatter outro value ${JSON.stringify(meta.outro)} — expected "deeper" or "closer"`);
  }

  const blocks = parseBlocks(mdSource.slice(fm[0].length));
  if (blocks[0]?.type !== "h1" || blocks[0].text !== meta.title) {
    throw new Error("article body must open with an h1 matching the frontmatter title");
  }

  const lastH2 = blocks.reduce((last, b, i) => (b.type === "h2" ? i : last), -1);
  const lastP = blocks.reduce((last, b, i) => (b.type === "p" ? i : last), -1);
  const out = [];
  out.push(`  <header class="hero-card">
    <p class="kicker">dev-loops</p>
    <h1>${renderInline(meta.title)}</h1>
    <p class="lede">${renderInline(meta.heroLede)}</p>
  </header>`);

  let inDeeper = false;
  const seenSlugs = new Set();
  for (const [i, block] of blocks.entries()) {
    if (block.type === "h1") continue;
    if (block.type === "h2") {
      const slug = slugify(block.text);
      if (slug === "") {
        throw new Error(`h2 heading ${JSON.stringify(block.text)} produces an empty slug id`);
      }
      if (seenSlugs.has(slug)) {
        throw new Error(`duplicate h2 slug "${slug}" — two sections would share one anchor id`);
      }
      seenSlugs.add(slug);
      if (i === lastH2 && outro === "deeper") {
        out.push(`  <hr class="rule" />`, ``, `  <section class="deeper">`);
        out.push(`    <h2 id="${slug}">${renderInline(block.text)}</h2>`);
        inDeeper = true;
      } else {
        out.push(`  <h2 id="${slug}">${renderInline(block.text)}</h2>`);
      }
    } else if (block.type === "part") {
      out.push(`  <div class="part">\n    <p class="kicker">Part ${block.num}</p>\n    <h2>${renderInline(block.title)}</h2>\n  </div>`);
    } else if (block.type === "h3") {
      out.push(inDeeper ? `    <h3>${renderInline(block.text)}</h3>` : `  <h3>${renderInline(block.text)}</h3>`);
    } else if (block.type === "blockquote") {
      out.push(inDeeper ? `    <blockquote>${renderInline(block.text)}</blockquote>` : `  <blockquote>${renderInline(block.text)}</blockquote>`);
    } else if (block.type === "diagram") {
      out.push(`  <figure>\n    <div class="diagram-scroll">\n${block.inner}\n    </div>\n    <figcaption>${renderDiagramCaption(block.caption)}</figcaption>\n  </figure>`);
    } else if (block.type === "p") {
      if (outro === "closer" && i === lastP) {
        out.push(`  <p class="closer">${renderInline(block.text)}</p>`);
      } else {
        out.push(inDeeper ? `    <p>${renderInline(block.text)}</p>` : `  <p>${renderInline(block.text)}</p>`);
      }
    } else if (block.type === "list") {
      out.push(`  <ul>\n${block.items.map((it) => `    <li>${renderInline(it)}</li>`).join("\n")}\n  </ul>`);
    } else if (block.type === "metrics") {
      out.push(renderMetrics(block.items));
    } else if (block.type === "code") {
      out.push(`  <pre><code>${markCodeComments(escapeHtml(block.text))}</code></pre>`);
    }
  }
  if (inDeeper) out.push(`  </section>`);

  const generated = `<!-- GENERATED from docs/articles/${sourceBasename} by scripts/pages/render-article.mjs — do not edit; edit the markdown and regenerate. -->`;
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
    results.push({ md, html, rendered: renderArticleHtml(mdSource, shell, md) });
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

if (isDirectCliRun(import.meta.url)) {
  await main();
}
