// docs/articles HTML twins listed in RENDERED_ARTICLES are derived artifacts:
// scripts/pages/render-article.mjs renders them from their markdown source.
// These contracts keep the pair from drifting the way the hand-synced twins
// did (stale command syntax, an invalid config example nobody re-checked):
// the checked-in HTML must match a fresh render, and the rendered page must
// keep the structural anchors build-site.mjs's nav injection and the
// Playwright fit harness rely on.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { RENDERED_ARTICLES, renderArticleHtml } from "../../scripts/pages/render-article.mjs";

const articlesUrl = new URL("../../docs/articles/", import.meta.url);
const shellUrl = new URL("../../scripts/pages/article-shell.html", import.meta.url);

async function freshRender({ md }) {
  const shell = await readFile(shellUrl, "utf8");
  const mdSource = await readFile(new URL(md, articlesUrl), "utf8");
  return renderArticleHtml(mdSource, shell, md);
}

for (const article of RENDERED_ARTICLES) {
  test(`docs/articles/${article.html} matches a fresh render of ${article.md}`, async () => {
    const checkedIn = await readFile(new URL(article.html, articlesUrl), "utf8");
    assert.equal(
      checkedIn,
      await freshRender(article),
      `docs/articles/${article.html} is stale — regenerate with \`node scripts/pages/render-article.mjs\``
    );
  });

  test(`rendered ${article.html} keeps the anchors nav injection and CSP depend on`, async () => {
    const html = await freshRender(article);
    // injectNav (build-site.mjs) throws without these two anchors.
    assert.ok(html.includes("</style>"), "missing </style> anchor for nav CSS injection");
    assert.match(html, /<body[^>]*>/, "missing <body> anchor for nav markup injection");
    // The injected nav CSS styles itself with these article design tokens.
    for (const token of ["--heading", "--kicker", "--accent-soft"]) {
      assert.ok(html.includes(token), `missing design token ${token} the nav CSS uses`);
    }
    // The fit harness asserts a locked CSP <meta> on every article page.
    assert.ok(
      html.includes('http-equiv="Content-Security-Policy"'),
      "missing Content-Security-Policy meta"
    );
    // Derived artifacts carry the do-not-edit provenance marker.
    assert.ok(html.includes("GENERATED from docs/articles/"), "missing GENERATED marker");
  });
}

test("in-page anchors written in the markdown resolve in the rendered HTML", async () => {
  for (const article of RENDERED_ARTICLES) {
    const mdSource = await readFile(new URL(article.md, articlesUrl), "utf8");
    const html = await freshRender(article);
    for (const [, anchor] of mdSource.matchAll(/\]\(#([^)]+)\)/g)) {
      assert.ok(
        html.includes(`id="${anchor}"`),
        `markdown links to #${anchor} but the rendered HTML has no such id`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Behavior units. The drift test above compares two outputs of the same code,
// so it cannot catch the renderer itself regressing; these pin the promised
// behaviors directly against synthetic inputs.
// ---------------------------------------------------------------------------

const MIN_SHELL = "<title>{{TITLE}}</title>\n{{GENERATED}}\n<style></style>\n";

function doc(body, { title = "T", heroLede = "L", outro } = {}) {
  const outroLine = outro ? `\noutro: ${outro}` : "";
  return `---\ntitle: "${title}"\nheroLede: "${heroLede}"${outroLine}\n---\n\n# ${title}\n\n${body}\n`;
}

const render = (body, fm) => renderArticleHtml(doc(body, fm), MIN_SHELL, "t.md");

test("renderer fails closed on unsupported markdown constructs", () => {
  for (const body of [
    "| a | b |",
    "  indented block start",
    "```text\nunterminated fence",
    "<!-- not-a-metrics-marker -->",
    "<!-- metrics -->\n- **1** item",
    "<!-- metrics:start -->\n- **1** unterminated block",
    "## ¿¿¿\n\nempty slug heading",
  ]) {
    assert.throws(() => render(body), `should throw for: ${JSON.stringify(body)}`);
  }
  assert.throws(() => renderArticleHtml("# no frontmatter\n\ntext\n", MIN_SHELL, "t.md"));
  assert.throws(() => renderArticleHtml('---\ntitle: "T"\n---\n\n# T\n\ntext\n', MIN_SHELL, "t.md"), /heroLede/);
  assert.throws(() => renderArticleHtml(doc("text"), MIN_SHELL, ""), /sourceBasename/);
  assert.throws(() => renderArticleHtml('---\ntitle: "T"\nheroLede: "L"\n---\n\n# Other\n\ntext\n', MIN_SHELL, "t.md"), /h1 matching/);
  assert.throws(() => render("## Same\n\na\n\n## Same\n\nb"), /duplicate h2 slug/);
});

test("relative .md links rewrite to .html; absolute and anchor links pass through", () => {
  const html = render(
    "See [a](./x.md), [b](../y.md#frag), [c](https://example.com/z.md), and [d](#the-end).\n\n## The end\n\nfin"
  );
  assert.ok(html.includes('href="./x.html"'), "./x.md should rewrite");
  assert.ok(html.includes('href="../y.html#frag"'), "../y.md#frag should rewrite keeping the fragment");
  assert.ok(html.includes('href="https://example.com/z.md"'), "absolute URLs must not rewrite");
  assert.ok(html.includes('href="#the-end"'), "in-page anchors must pass through");
});

test("quotes in link targets and text are attribute-safe", () => {
  const html = render('A [q](./a"b.md) link and a "quoted" word.');
  assert.ok(html.includes('href="./a&quot;b.html"'), "quote in href must be escaped");
  assert.ok(!html.includes('href="./a"b'), "raw quote must not break out of the attribute");
  assert.ok(html.includes("&quot;quoted&quot;"));
});

test("metrics-marked lists render as .metric cards and reject malformed items", () => {
  const html = render("<!-- metrics:start -->\n- **42** things counted\n- **~7/day** of pace\n<!-- metrics:end -->");
  assert.ok(html.includes('<div class="num">42</div>'));
  assert.ok(html.includes('<div class="lab">things counted</div>'));
  assert.ok(html.includes('<div class="num">~7/day</div>'));
  assert.throws(() => render("<!-- metrics:start -->\n- no bold prefix\n<!-- metrics:end -->"), /metrics item/);
});

test("code-fence # comments get .cm spans; non-comment # stays plain", () => {
  const html = render("```text\nrun me   # trailing note\n# full-line note\nvalue a#b stays\n```");
  assert.ok(html.includes('<span class="cm"># trailing note</span>'));
  assert.ok(html.includes('<span class="cm"># full-line note</span>'));
  assert.ok(html.includes("value a#b stays"), "a#b must not be treated as a comment");
  assert.equal(html.match(/class="cm"/g).length, 2);
});

test("generated page carries slug ids, hero fields, and the provenance marker", () => {
  const html = render("intro para\n\n## First Section\n\nbody\n\n## Keep going\n\nout", { title: "My Page", heroLede: "The lede." });
  assert.ok(html.includes("<title>My Page</title>"));
  assert.ok(html.includes('<p class="lede">The lede.</p>'));
  assert.ok(html.includes('<h2 id="first-section">'));
  assert.ok(html.includes('<section class="deeper">'), "last h2 section becomes the deeper outro");
  assert.ok(html.includes("GENERATED from docs/articles/t.md"));
});

// ---------------------------------------------------------------------------
// Diagram figure unit: ```mermaid fence + *Diagram N — Title. …* caption +
// <!-- figure … --> region. Mermaid source is dropped; the region's inner
// HTML is emitted verbatim inside the figure.
// ---------------------------------------------------------------------------

test("diagram figure unit renders a figure with the region's inner HTML emitted verbatim", () => {
  const html = render([
    "```mermaid",
    "flowchart LR",
    "  A --> B",
    "```",
    "",
    "*Diagram 1 — Title. Rest of the caption.*",
    "",
    "<!-- figure",
    '      <svg viewBox="0 0 10 10"><text>A &rarr; B</text></svg>',
    "-->",
  ].join("\n"));
  assert.ok(!html.includes("flowchart LR"), "mermaid source must be dropped from the HTML output");
  assert.ok(html.includes('<div class="diagram-scroll">'));
  assert.ok(html.includes('<svg viewBox="0 0 10 10"><text>A &rarr; B</text></svg>'), "figure region inner HTML must survive verbatim, including entities and <svg");
  assert.ok(html.includes("<figcaption><b>Diagram 1 — Title.</b> Rest of the caption.</figcaption>"), "figcaption bold-splits on the first '. '");
});

test("diagram figure unit tolerates zero blank lines between fence, caption, and figure region (D5/D6/D7 shape)", () => {
  const html = render([
    "```mermaid",
    "flowchart LR",
    "  A --> B",
    "```",
    "*Diagram 2 — Title. Rest.*",
    "<!-- figure",
    '      <div class="flow">X</div>',
    "-->",
  ].join("\n"));
  assert.ok(html.includes('<div class="flow">X</div>'));
});

test("diagram figure unit fails closed on a malformed coupled triple", () => {
  const fence = ["```mermaid", "flowchart LR", "  A --> B", "```"].join("\n");
  const goodCaption = "*Diagram 1 — Title. Rest.*";
  for (const body of [
    `${fence}\n\nno caption here\n`,
    `${fence}\n\n${goodCaption}\n\nno figure region\n`,
    `${fence}\n\n${goodCaption}\n\n<!-- figure\n  <div>x</div>\n`,
    `${fence}\n\nDiagram 1 without asterisks or em dash\n\n<!-- figure\n  <div>x</div>\n-->\n`,
    `${fence}\n\n${goodCaption}\n\n<!-- figure\n  <ScRiPt>alert(1)</ScRiPt>\n-->\n`,
  ]) {
    assert.throws(() => render(body), `should throw for: ${JSON.stringify(body)}`);
  }
});

test("figure region rejects nested HTML comments (M1) and requires an exact-line '-->' terminator (M2)", () => {
  const fence = ["```mermaid", "flowchart LR", "  A --> B", "```"].join("\n");
  const caption = "*Diagram 1 — Title. Rest.*";
  assert.throws(
    () => render(`${fence}\n\n${caption}\n\n<!-- figure\n  <!-- nested -->\n  <div>after</div>\n-->\n`),
    /nested/i,
  );
  assert.throws(
    () => render(`${fence}\n\n${caption}\n\n<!-- figure\n  <div>text with --> inline</div>\n-->\n`),
    /nested/i,
  );
});

test("stray <!-- figure without a preceding mermaid fence still hits the unsupported-comment throw", () => {
  assert.throws(() => render("<!-- figure\n  <div>x</div>\n-->\n"), /unsupported HTML comment/);
});

// ---------------------------------------------------------------------------
// Part divider: a non-first h1 must be a "Part N — Title" line.
// ---------------------------------------------------------------------------

test("a non-first h1 shaped \"Part N — Title\" renders as a part divider", () => {
  const html = render("intro\n\n# Part 1 — Eliminating coordination delay\n\n## Section\n\nbody");
  assert.ok(html.includes('<div class="part">'));
  assert.ok(html.includes('<p class="kicker">Part 1</p>'));
  assert.ok(html.includes("<h2>Eliminating coordination delay</h2>"));
});

test("a non-first h1 not shaped like a part divider throws", () => {
  assert.throws(() => render("intro\n\n# Just Another Heading\n\nbody"), /Part N/);
});

// ---------------------------------------------------------------------------
// Blockquote: a run of "> "-prefixed lines renders as one <blockquote>.
// ---------------------------------------------------------------------------

test("a run of \"> \" lines renders as one blockquote with inline rendering applied", () => {
  const html = render("> See [more](./x.md) here.\n> Second line.");
  assert.ok(html.includes("<blockquote>See <a href=\"./x.html\">more</a> here. Second line.</blockquote>"));
});

test("a bare \">\" or nested \">>\" blockquote line throws", () => {
  assert.throws(() => render(">no space"));
  assert.throws(() => render("> ok\n>>nested"));
});

// ---------------------------------------------------------------------------
// h3: no rendered article uses ###; the parser fails closed on it, so support
// can land with the first real use.
// ---------------------------------------------------------------------------

test("### fails closed as an unsupported construct", () => {
  assert.throws(() => render("### A subheading\n\nbody"));
});

// ---------------------------------------------------------------------------
// outro frontmatter: default "deeper" keeps today's boxed-outro behavior;
// "closer" unboxes the last h2 and marks the final paragraph .closer.
// ---------------------------------------------------------------------------

test('frontmatter outro: "closer" renders the last h2 unboxed and the final paragraph as <p class="closer">', () => {
  const html = render("intro\n\n## First\n\na\n\n## Last\n\nb\n\nfinal para", { outro: "closer" });
  assert.ok(!html.includes('<section class="deeper">'), "closer outro must not box the last h2");
  assert.ok(!html.includes('<hr class="rule" />'), "closer outro must not add the deeper rule");
  assert.ok(html.includes('<h2 id="last">Last</h2>'), "last h2 still renders, just unboxed");
  assert.ok(html.includes('<p class="closer">final para</p>'));
});

test("default outro (deeper) still boxes the last h2 behind the rule", () => {
  const html = render("intro\n\n## First\n\na\n\n## Last\n\nb\n\nfinal para");
  assert.ok(html.includes('<hr class="rule" />'));
  assert.ok(html.includes('<section class="deeper">'));
  assert.ok(!html.includes('class="closer"'));
});

test("unknown outro frontmatter value throws", () => {
  assert.throws(() => render("intro\n\n## Last\n\nb", { outro: "bogus" }), /outro/);
});
