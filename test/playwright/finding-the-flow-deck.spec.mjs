import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { deckRegistryEntry, defineDeckSuite, makeDeckServer } from "./harness/deck-fit-harness.mjs";
import { startFixtureServer, stopFixtureServer } from "./harness/webkit-smoke-harness.mjs";

const entry = deckRegistryEntry("finding-the-flow-deck");
const deckPath = fileURLToPath(new URL(`../../docs/presentations/${entry.deck}`, import.meta.url));

test.setTimeout(60_000);

defineDeckSuite({ ...entry, deckPath, desktopFit: true, mobileFit: true, evidenceAssertions: true });

test("speaker notes reserve fifty minutes of content and ten for questions", () => {
  const notes = readFileSync(new URL("../../docs/presentations/finding-the-flow-speaker-notes.md", import.meta.url), "utf8");
  const headings = [...notes.matchAll(/^## (\d+)\. .* — (.+)$/gm)];
  expect(headings.map((heading) => Number(heading[1]))).toEqual(Array.from({ length: 43 }, (_, index) => index + 1));
  const seconds = headings.slice(0, -1).map((heading) => {
    const [minutes, seconds] = heading[2].split(":").map(Number);
    return minutes * 60 + seconds;
  });
  expect(seconds.reduce((total, duration) => total + duration, 0)).toBe(50 * 60);
  expect(seconds[6]).toBe(90);
  expect(seconds.slice(30, 37).reduce((total, duration) => total + duration, 0)).toBe(10.5 * 60);
  expect(seconds[37]).toBe(2 * 60);
  expect(notes).toContain("| Questions, with sources on screen | 43 | 10:00 |");
});

test("finding the flow supports keyboard navigation and keeps links usable", async ({ page }) => {
  const { server, url } = await startFixtureServer(() => makeDeckServer(deckPath));
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(url);
    await expect(page.locator("section.slide")).toHaveCount(43);
    expect(await page.locator(".footer").allTextContents()).toEqual(Array.from({ length: 43 }, (_, index) => `${index + 1} / 43`));
    await expect(page.locator("#grill .graph")).toHaveAttribute("aria-label", /human.*approved/i);
    await expect(page.locator("#grill")).toContainText("People decide intent and tradeoffs.");
    await expect(page.locator("#budget-stop")).toContainText("A limit cannot weaken acceptance criteria or mark unfinished work complete.");
    await expect(page.locator("#tool-result")).toContainText("unknown");
    await expect(page.locator("#context-choice")).toContainText("cache");
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
