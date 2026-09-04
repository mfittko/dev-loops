import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { deckRegistryEntry, defineDeckSuite, makeDeckServer } from "./harness/deck-fit-harness.mjs";
import { startFixtureServer, stopFixtureServer } from "./harness/webkit-smoke-harness.mjs";

const entry = deckRegistryEntry("state-graph-surface-deck");

defineDeckSuite({
  ...entry,
  deckPath: fileURLToPath(new URL(`../../docs/presentations/${entry.deck}`, import.meta.url)),
});

test("state-graph deck keyboard navigation respects modifiers and slide boundaries", async ({ page }) => {
  const deckPath = fileURLToPath(new URL(`../../docs/presentations/${entry.deck}`, import.meta.url));
  const { server, url } = await startFixtureServer(() => makeDeckServer(deckPath));
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const modifiedPrevented = await page.evaluate(() => {
      const event = new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true, cancelable: true });
      dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(modifiedPrevented).toBe(false);
    expect(await page.evaluate(() => scrollY)).toBe(0);

    await page.keyboard.press("ArrowLeft");
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await page.keyboard.press("End");
    await page.waitForFunction(() => scrollY > innerHeight * 9);
    const atEnd = await page.evaluate(() => scrollY);
    await page.keyboard.press("ArrowRight");
    expect(await page.evaluate(() => scrollY)).toBe(atEnd);
  } finally {
    await stopFixtureServer(server);
  }
});
