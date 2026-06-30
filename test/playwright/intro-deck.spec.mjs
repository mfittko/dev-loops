import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { deckRegistryEntry, defineDeckSuite, makeDeckServer } from "./harness/deck-fit-harness.mjs";
import { startFixtureServer, stopFixtureServer } from "./harness/webkit-smoke-harness.mjs";

const entry = deckRegistryEntry("intro-deck");
const deckPath = fileURLToPath(new URL(`../../docs/presentations/${entry.deck}`, import.meta.url));

defineDeckSuite({
  ...entry,
  deckPath,
});

const scrollTop = (page) => page.evaluate(() => Math.max(document.documentElement.scrollTop, document.body.scrollTop));
const resetScroll = (page) => page.evaluate(() => {
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
});
const viewportHeight = (page) => page.evaluate(() => window.innerHeight);

test("webkit intro deck keyboard navigation advances, backs up, and ignores guarded keys", async ({ page }) => {
  const { server, url } = await startFixtureServer(() => makeDeckServer(deckPath));
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#hero")).toBeVisible();

    const height = await viewportHeight(page);
    await page.keyboard.press("Control+ArrowDown");
    await page.waitForTimeout(50);
    expect(await scrollTop(page)).toBeLessThan(height * 0.9);
    await resetScroll(page);

    await page.keyboard.press("Shift+ArrowDown");
    await page.waitForTimeout(50);
    expect(await scrollTop(page)).toBeLessThan(height * 0.9);
    await resetScroll(page);

    await page.evaluate(() => {
      const input = document.createElement("input");
      input.id = "keyboard-test-input";
      input.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0";
      document.body.appendChild(input);
      input.focus();
    });
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(50);
    expect(await scrollTop(page)).toBeLessThan(height * 0.5);
    await resetScroll(page);

    await page.evaluate(() => {
      document.getElementById("keyboard-test-input")?.remove();
      document.body.tabIndex = -1;
      document.body.focus();
    });
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction(() => Math.max(document.documentElement.scrollTop, document.body.scrollTop) > window.innerHeight * 0.5);
    await expect(page.locator("#coordination-cost")).toBeVisible();

    await page.keyboard.press("ArrowUp");
    await page.waitForFunction(() => Math.max(document.documentElement.scrollTop, document.body.scrollTop) < window.innerHeight * 0.5);
    await expect(page.locator("#hero")).toBeVisible();
  } finally {
    await stopFixtureServer(server);
  }
});
