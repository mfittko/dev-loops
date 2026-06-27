import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { test, expect } from "@playwright/test";

import { captureNamedUiState, startFixtureServer, stopFixtureServer } from "./harness/webkit-smoke-harness.mjs";

const DECK_PATH = fileURLToPath(new URL("../../docs/presentations/applied-dev-loops.html", import.meta.url));

// A single-file static server is enough for one self-contained deck: serve the
// deck only at the root, and 404 everything else so requests stay deterministic.
function makeDeckServer() {
  return createServer(async (req, res) => {
    const route = (req.url ?? "/").split("?")[0];
    if (route !== "/" && route !== "/index.html") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }
    try {
      const html = await readFile(DECK_PATH, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(error));
    }
  });
}

// The named states the designer/vision review loop targets. Each must be a
// stable <section id> in the rendered deck.
const NAMED_STATES = [
  { id: "hero", stateName: "Hero" },
  { id: "core-idea", stateName: "Core idea" },
  { id: "parallel-review", stateName: "Parallel review" },
  { id: "trust", stateName: "Trust / never-lie" },
  { id: "impact", stateName: "Impact" },
];

test("webkit renders the applied deck and captures named states", async ({ page }, testInfo) => {
  const { server, url } = await startFixtureServer(makeDeckServer);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // Deck is one standalone document: every named section is present.
    for (const { id } of NAMED_STATES) {
      await expect(page.locator(`#${id}`)).toHaveCount(1);
    }

    // No sideways scroll on the body (wide content gets its own overflow-x).
    const horizontallyOverflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(horizontallyOverflows).toBe(false);

    for (const { id, stateName } of NAMED_STATES) {
      const section = page.locator(`#${id}`);
      await section.scrollIntoViewIfNeeded();
      await expect(section).toBeVisible();

      await captureNamedUiState({
        page,
        testInfo,
        sliceId: "applied-deck",
        stateName,
        // Frame each capture on the in-view section, not the whole scroll
        // document, so the designer-review loop sees one state per artifact.
        fullPage: false,
        metadata: {
          fixture: path.basename(DECK_PATH),
          route: `#${id}`,
          reviewHint: `Designer-review state for the "${id}" deck section.`,
        },
      });
    }
  } finally {
    await stopFixtureServer(server);
  }
});
