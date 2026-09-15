import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { deckRegistryEntry, defineDeckSuite, makeDeckServer } from "./harness/deck-fit-harness.mjs";
import { startFixtureServer, stopFixtureServer } from "./harness/webkit-smoke-harness.mjs";

const entry = deckRegistryEntry("finding-the-flow-deck");
const deckPath = fileURLToPath(new URL(`../../docs/presentations/${entry.deck}`, import.meta.url));

defineDeckSuite({ ...entry, deckPath, desktopFit: true, mobileFit: true, evidenceAssertions: true });

test("finding the flow supports keyboard navigation and keeps links usable", async ({ page }) => {
  const { server, url } = await startFixtureServer(() => makeDeckServer(deckPath));
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(url);
    await expect(page.locator("#ui-findings img")).toHaveJSProperty("naturalWidth", 1280);
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => scrollY > innerHeight / 2);
    await page.keyboard.press("Home");
    await page.waitForFunction(() => scrollY === 0);
    await page.keyboard.press("ArrowLeft");
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await page.keyboard.press("End");
    await page.waitForFunction(() => scrollY > innerHeight * 14);
    const link = page.locator("#reading a").first();
    await link.focus();
    const prevented = await link.evaluate((element) => {
      const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(prevented).toBe(false);
  } finally {
    await stopFixtureServer(server);
  }
});
