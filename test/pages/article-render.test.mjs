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
  return renderArticleHtml(mdSource.replace(/^---\n/, `---\nsourceBasename: ${md}\n`), shell);
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
