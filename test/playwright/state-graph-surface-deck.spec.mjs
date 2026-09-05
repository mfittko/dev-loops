import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { assertA11yClean, assertRuntimeClean, deckRegistryEntry, defineDeckSuite, makeDeckServer } from "./harness/deck-fit-harness.mjs";
import { startFixtureServer, stopFixtureServer } from "./harness/webkit-smoke-harness.mjs";

const entry = deckRegistryEntry("state-graph-surface-deck");

defineDeckSuite({
  ...entry,
  desktopFit: true,
  mobileFit: true,
  evidenceAssertions: true,
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

    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => scrollY > innerHeight * 0.5);
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(() => scrollY < innerHeight * 0.5);
    await page.keyboard.press("End");
    await page.waitForFunction(() => scrollY > innerHeight * 9);
    const atEnd = await page.evaluate(() => scrollY);
    await page.keyboard.press("ArrowRight");
    expect(await page.evaluate(() => scrollY)).toBe(atEnd);
    await page.keyboard.press("Home");
    await page.waitForFunction(() => scrollY < innerHeight * 0.5);
  } finally {
    await stopFixtureServer(server);
  }
});

test("state-graph deck evidence guards reject axe and runtime failures", () => {
  expect(() => assertA11yClean({ violations: [{ id: "deliberate-violation" }] })).toThrow(/accessibility violations/);
  expect(() => assertRuntimeClean({ consoleErrors: ["deliberate error"], failedRequests: [] })).toThrow(/console\/page errors/);
  expect(() => assertRuntimeClean({ consoleErrors: [], failedRequests: ["GET /missing: failed"] })).toThrow(/failed requests/);
});
