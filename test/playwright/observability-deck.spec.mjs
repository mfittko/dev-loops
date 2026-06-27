import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { test, expect } from "@playwright/test";

import { captureNamedUiState, startFixtureServer, stopFixtureServer } from "./harness/webkit-smoke-harness.mjs";

const DECK_PATH = fileURLToPath(new URL("../../docs/presentations/process-observability.html", import.meta.url));

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

// Every named state must be a stable <section id> in the rendered deck. The
// designer/vision review loop captures the load-bearing ones (hero,
// observable-state, instrumented, metrics, close); the rest are asserted present
// so the structure can't silently drift.
const NAMED_STATES = [
  { id: "hero", stateName: "Hero", capture: true },
  { id: "interrupt-cost", stateName: "Interrupt cost", capture: false },
  { id: "handoff", stateName: "Handoff cost", capture: false },
  { id: "blind-spot", stateName: "Blind spot", capture: false },
  { id: "observable-state", stateName: "Observable state", capture: true },
  { id: "measurement-loop", stateName: "Measurement loop", capture: false },
  { id: "instrumented", stateName: "Instrumented", capture: true },
  { id: "metrics", stateName: "Metrics", capture: true },
  { id: "close", stateName: "Close", capture: true },
];

test("webkit renders the observability deck and captures named states", async ({ page }, testInfo) => {
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

    for (const { id, stateName, capture } of NAMED_STATES) {
      const section = page.locator(`#${id}`);
      await section.scrollIntoViewIfNeeded();
      await expect(section).toBeVisible();

      if (!capture) continue;

      await captureNamedUiState({
        page,
        testInfo,
        sliceId: "observability-deck",
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
