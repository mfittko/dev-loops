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
        // Keep fit measurements and captures independent of Google Fonts availability.
        // This test-only stylesheet pins local fallback faces before either navigation.
        await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({
          contentType: "text/css",
          body: ':root { --sans: Arial, sans-serif !important; --display: Arial, sans-serif !important; --mono: "Courier New", monospace !important; }',
        }));
        await page.route("https://fonts.gstatic.com/**", (route) => route.abort());
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
        const graph = page.getByRole(sliceId === "simulator-article" ? "group" : "img", { name: /lifecycle/i });
        await expect(graph).toBeVisible();
        await expect(graph.getByText("startup", { exact: true })).toBeVisible();
        await expect(page.locator('#chips button[aria-pressed="true"]')).toHaveCount(1);
        await expect(page.locator("#stepno")).toHaveText("Step 0");
        await expect(page.locator("#now")).toHaveText("Ready");

        if (sliceId === "simulator-article") {
          const openGraph = graph.getByRole("button", { name: /^Open the .* sub-loop$/ }).first();
          for (const key of ["Enter", "Space"]) {
            await openGraph.focus();
            await page.keyboard.press(key);
            await expect(page.getByRole("button", { name: "Back to the run", exact: true })).toBeVisible();
            await expect(page.locator("#stepno")).toHaveText("Step 0");
            await page.getByRole("button", { name: "Back to the run", exact: true }).click();
            await expect(graph).toBeVisible();
          }
          // Panning a manually opened leaf graph must never step or rewind the run.
          await page.locator("#next").click();
          await page.locator('#nav [data-g="impl"]').click();
          const scroller = page.getByRole("region", { name: "Workflow graph — use arrow keys to scroll", exact: true });
          const execution = () => page.evaluate(() => ({
            step: document.getElementById("stepno").textContent,
            now: document.getElementById("now").textContent,
            records: document.getElementById("state").textContent,
            trace: document.getElementById("trace").textContent,
          }));
          const frozen = await execution();
          for (const full of [false, true]) {
            if (full) await page.keyboard.press("f");
            for (let tab = 0; tab < 128 && !await scroller.evaluate(el => el === document.activeElement); tab++) {
              await page.keyboard.press("Tab");
            }
            await expect(scroller).toBeFocused();
            const owner = page.locator(full ? ".board" : "#scroller");
            const style = await owner.getAttribute("style");
            // Constrain only the fixture viewport to guarantee both overflow axes.
            await owner.evaluate((el) => {
              el.style.width = "240px";
              el.style.height = "180px";
              el.style.overflow = "auto";
              el.scrollLeft = 0;
              el.scrollTop = 0;
            });
            for (const [forward, backward, offset] of [
              ["ArrowRight", "ArrowLeft", "scrollLeft"],
              ["ArrowDown", "ArrowUp", "scrollTop"],
            ]) {
              const before = await owner.evaluate((el, key) => el[key], offset);
              await page.keyboard.press(forward);
              await expect.poll(() => owner.evaluate((el, key) => el[key], offset)).toBeGreaterThan(before);
              const moved = await owner.evaluate((el, key) => el[key], offset);
              await page.keyboard.press(backward);
              await expect.poll(() => owner.evaluate((el, key) => el[key], offset)).toBeLessThan(moved);
              expect(await execution()).toEqual(frozen);
            }
            await owner.evaluate((el, prior) => prior === null ? el.removeAttribute("style") : el.setAttribute("style", prior), style);
            if (full) await page.keyboard.press("f");
          }
          await page.getByRole("button", { name: "Back to the run", exact: true }).click();
          await page.locator("#reset").click();
        }

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
        await page.getByRole("button", { name: "Run to the end", exact: true }).click();
        const completedStep = await page.locator("#stepno").textContent();
        const trace = page.getByRole("list", { name: "Trace", exact: true });
        await trace.focus();
        await expect(trace).toBeFocused();
        await page.keyboard.press("Home");
        await expect.poll(() => trace.evaluate((el) => el.scrollTop)).toBe(0);
        await page.keyboard.press("PageDown");
        await expect.poll(() => trace.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        await page.keyboard.press("ArrowLeft");
        await expect(page.locator("#stepno")).toHaveText(completedStep);
        await assertFit();
        expect(pageErrors, "simulator scripts must render and respond without page errors").toEqual([]);
      } finally {
        await stopFixtureServer(server);
      }
    });
  }
}
