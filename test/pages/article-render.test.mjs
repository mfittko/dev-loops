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

function doc(body, { title = "T", heroLede = "L" } = {}) {
  return `---\ntitle: "${title}"\nheroLede: "${heroLede}"\n---\n\n# ${title}\n\n${body}\n`;
}

const render = (body, fm) => renderArticleHtml(doc(body, fm), MIN_SHELL, "t.md");

test("renderer fails closed on unsupported markdown constructs", () => {
  for (const body of [
    "> a blockquote",
    "| a | b |",
    "  indented block start",
    "```text\nunterminated fence",
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
