import path from "node:path";

import { test, expect } from "@playwright/test";

import { MOBILE, assertDeckFit, makeDeckServer, measureArticleFit, settleMobile } from "./deck-fit-harness.mjs";
import { captureNamedUiState, startFixtureServer, stopFixtureServer } from "./webkit-smoke-harness.mjs";

// Interactive teaching pages are continuous documents, not CSP-locked prose
// articles or viewport-height deck slides. Reuse their shared layout measurement
// and assertions, including intentional scrolling inside the graph board.
export function defineSimulatorSuite({
  sliceId,
  articlePath,
  heading,
  currentView,
  linkedView,
  linkedFile,
  firstStep,
  firstTrace,
}) {
  for (const [device, viewport] of [
    ["desktop", { width: 1280, height: 800 }],
    ["mobile", MOBILE],
  ]) {
    test(`webkit ${sliceId} renders usable controls and fits the ${device} viewport`, async ({ page }, testInfo) => {
      const { server, url } = await startFixtureServer(() => makeDeckServer(articlePath));
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(String(error)));
      const assertFit = async () => assertDeckFit(await measureArticleFit(page), `${viewport.width}x${viewport.height} ${device} viewport`);
      const capture = async (stateName, route) => captureNamedUiState({
        page,
        testInfo,
        sliceId,
        stateName,
        viewport,
        fullPage: false,
        metadata: {
          fixture: path.basename(articlePath),
          route,
          reviewHint: `${device} simulator layout: rendered graph, usable controls, no document overflow or clipped sections.`,
        },
      });

      try {
        if (device === "mobile") {
          await settleMobile(page, url);
        } else {
          await page.setViewportSize(viewport);
          await page.goto(url, { waitUntil: "domcontentloaded" });
          await page.waitForLoadState("networkidle");
          await page.evaluate(() => document.fonts.ready);
        }

        await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
        const views = page.getByRole("navigation", { name: "Simulator view" });
        await expect(views.getByRole("link", { name: currentView, exact: true })).toHaveAttribute("aria-current", "page");
        const crosslink = views.getByRole("link", { name: linkedView, exact: true });
        await expect(crosslink).toBeVisible();
        await expect(crosslink).toHaveAttribute("href", linkedFile);
        const graph = page.getByRole("img", { name: /lifecycle/i });
        await expect(graph).toBeVisible();
        await expect(graph.getByText("startup", { exact: true })).toBeVisible();
        await expect(page.locator('#chips button[aria-pressed="true"]')).toHaveCount(1);
        await expect(page.locator("#stepno")).toHaveText("Step 0");
        await expect(page.locator("#now")).toHaveText("Ready");

        const next = page.getByRole("button", { name: "Next step", exact: true });
        const back = page.getByRole("button", { name: "Back", exact: true });
        await expect(next).toBeVisible();
        await expect(next).toBeEnabled();
        await expect(back).toBeDisabled();
        await expect(page.getByRole("button", { name: "Run to the end", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Full window", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Hide roles", exact: true })).toBeVisible();
        await assertFit();
        await page.getByRole("heading", { level: 1 }).scrollIntoViewIfNeeded();
        await capture("Ready", "/");

        await page.getByText("Starting conditions", { exact: true }).click();
        await expect(page.locator("#facts").getByRole("combobox").first()).toBeVisible();
        await assertFit();
        await next.click();
        await expect(page.locator("#stepno")).toHaveText("Step 1");
        await expect(page.locator("#now")).toHaveText(firstStep);
        await expect(page.locator("#trace")).toContainText(firstTrace);
        await expect(back).toBeEnabled();
        await assertFit();
        await page.locator("#stepno").scrollIntoViewIfNeeded();
        await capture(firstStep, "#stepno");

        await back.click();
        await expect(page.locator("#stepno")).toHaveText("Step 0");
        await expect(page.locator("#now")).toHaveText("Ready");
        await expect(back).toBeDisabled();
        await next.click();
        await page.getByRole("button", { name: "Reset", exact: true }).click();
        await expect(page.locator("#stepno")).toHaveText("Step 0");
        await expect(page.locator("#now")).toHaveText("Ready");
        await expect(next).toBeEnabled();
        await expect(back).toBeDisabled();
        await assertFit();
        expect(pageErrors, "simulator scripts must render and respond without page errors").toEqual([]);
      } finally {
        await stopFixtureServer(server);
      }
    });
  }
}
