import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test, expect } from "@playwright/test";

import { buildSite, STATE_ATLAS } from "../../scripts/pages/build-site.mjs";

import { articleRegistryEntry } from "./harness/deck-fit-harness.mjs";
import { defineSimulatorSuite } from "./harness/simulator-harness.mjs";

const entry = articleRegistryEntry("simulator-overview-article");

defineSimulatorSuite({
  ...entry,
  articlePath: fileURLToPath(new URL(`../../docs/articles/${entry.file}`, import.meta.url)),
  heading: "One issue, from startup to merge",
  currentView: "Overview: the lifecycle",
  linkedView: "Detailed: every sub-loop",
  linkedFile: "simulator.html",
  firstStep: "loop startup",
  firstTrace: "startup:",
});

test("retained atlas diagrams open and close fullscreen overlays when native fullscreen is unavailable or denied", async ({ page }) => {
  const out = await mkdtemp(join(tmpdir(), "pages-atlas-fullscreen-"));
  try {
    await buildSite({ outDir: out });
    await page.route("http://atlas.test/**", async route => {
      const asset = new URL(route.request().url()).pathname === "/assets/mermaid.min.js";
      await route.fulfill({
        contentType: asset ? "text/javascript" : "text/html",
        body: await readFile(join(out, asset ? "assets/mermaid.min.js" : STATE_ATLAS.file)),
      });
    });
    await page.goto("http://atlas.test/");
    const diagrams = page.locator(".diagram");
    const count = await diagrams.count();
    expect(count).toBeGreaterThan(0);
    for (const denied of [false, true]) {
      // Cover Safari's absent API and a browser refusing a fullscreen request.
      await page.evaluate(denied => {
        Object.defineProperty(Element.prototype, "requestFullscreen", {
          configurable: true,
          value: denied ? () => Promise.reject(new Error("Fullscreen denied")) : undefined,
        });
        Object.defineProperty(Element.prototype, "webkitRequestFullscreen", { configurable: true, value: undefined });
      }, denied);
      for (let i = 0; i < count; i++) {
        const diagram = diagrams.nth(i);
        const expand = diagram.getByRole("button", { name: "View diagram fullscreen", exact: true });
        await expect(expand).toHaveCount(1);
        const graph = diagram.locator(".mermaid");
        await expect(graph.locator("svg")).toBeVisible();
        await expand.click();
        await expect(graph).toHaveClass(/fs-fallback/);
        expect(await graph.boundingBox()).toEqual({
          x: 0, y: 0, width: page.viewportSize().width, height: page.viewportSize().height,
        });
        await graph.click({ position: { x: 8, y: 8 } });
        await expect(graph).not.toHaveClass(/fs-fallback/);
      }
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
