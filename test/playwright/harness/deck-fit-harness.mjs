import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { test, expect } from "@playwright/test";

import { captureNamedUiState, startFixtureServer, stopFixtureServer } from "./webkit-smoke-harness.mjs";

// Shared deck-fit harness: the assertions that used to be copy-pasted across
// every self-contained presentation deck spec (intro, deep-dive, …). Each deck
// registers as data and `defineDeckSuite` runs the identical assertions over it.

export const MOBILE = { width: 390, height: 844 };

// A single-file static server is enough for one self-contained deck: serve the
// deck only at the root, and 404 everything else so requests stay deterministic.
export function makeDeckServer(deckPath) {
  return createServer(async (req, res) => {
    const route = (req.url ?? "/").split("?")[0];
    if (route !== "/" && route !== "/index.html") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }
    try {
      const html = await readFile(deckPath, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(error));
    }
  });
}

// Settle the layout (viewport applied, fonts loaded, network idle) before
// measuring so the cold-start false-fail — measuring desktop ~815px geometry —
// can't happen.
export async function settleMobile(page, url) {
  await page.setViewportSize(MOBILE);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
  await page.waitForFunction((w) => window.innerWidth === w, MOBILE.width);
  await page.evaluate(() => document.fonts.ready);
}

// Returns { hOffenders, pageScrollWidth, innerWidth, clipped } measured after settle.
export async function measureFit(page) {
  return page.evaluate(() => {
    const iw = window.innerWidth;
    const hOffenders = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Diagrams must now FIT, not scroll: no overflow-x:auto exemption.
      if (r.right > iw + 1) {
        hOffenders.push(`<${el.tagName.toLowerCase()} class="${el.className}"> right=${Math.round(r.right)} "${(el.textContent || "").trim().slice(0, 32)}"`);
      }
    }
    // Vertical clip: a section whose content is taller than its box while its
    // own overflow-y is hidden has cut-off content.
    const clipped = [];
    for (const el of document.querySelectorAll("section")) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "hidden" || oy === "clip") && el.clientHeight + 1 < el.scrollHeight) {
        clipped.push(`<${el.tagName.toLowerCase()} id="${el.id}"> client=${el.clientHeight} scroll=${el.scrollHeight}`);
      }
    }
    return {
      hOffenders,
      clipped,
      pageScrollWidth: document.scrollingElement.scrollWidth,
      innerWidth: iw,
    };
  });
}

// Assert every registered section id is present exactly once and no sideways
// scroll on the document. Shared by decks (and reusable by other artifacts).
export async function assertSectionIdsAndNoHorizontalScroll(page, sectionIds) {
  for (const id of sectionIds) {
    await expect(page.locator(`#${id}`)).toHaveCount(1);
  }
  const horizontallyOverflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(horizontallyOverflows).toBe(false);
}

// CSP-meta guard: a self-contained deck must ship a restrictive
// Content-Security-Policy <meta> so the published static page can't be coerced
// into loading off-origin script/style.
export async function assertCspMeta(page) {
  const csp = await page.evaluate(() => {
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    return meta ? meta.getAttribute("content") : null;
  });
  expect(csp, "deck must ship a Content-Security-Policy <meta>").toBeTruthy();
  expect(csp, "CSP must lock default-src to 'none'").toContain("default-src 'none'");
}

// Assert the mobile (390px) layout fits: per-element right edge, defensive
// page scrollWidth, and per-section vertical-clip.
export function assertMobileFit(m) {
  expect(m.hOffenders, `elements overflow the ${MOBILE.width}px viewport (must FIT, not scroll):\n${m.hOffenders.join("\n")}`).toEqual([]);
  // Defensive secondary: body{overflow-x:hidden} clips page-level growth, so this
  // line rarely fires on its own — the per-element check above is the real catch.
  expect(m.pageScrollWidth, "page scrollWidth exceeds the viewport (defensive check)").toBeLessThanOrEqual(m.innerWidth + 1);
  expect(m.clipped, `sections clip content with overflow:hidden (taller than their box):\n${m.clipped.join("\n")}`).toEqual([]);
}

// Registry-driven runner: defines the full per-deck suite from one data entry.
//   { sliceId, deckPath, sectionIds, mobileCapture: { id, stateName } }
// `sectionIds` may be plain ids or { id, stateName, capture } entries; entries
// with capture !== false get a desktop named-state capture.
export function defineDeckSuite({ sliceId, deckPath, sectionIds, mobileCapture }) {
  const states = sectionIds.map((entry) =>
    typeof entry === "string" ? { id: entry, stateName: entry, capture: true } : { capture: true, stateName: entry.id, ...entry });
  const ids = states.map((s) => s.id);
  const deckName = path.basename(deckPath);
  const startServer = () => startFixtureServer(() => makeDeckServer(deckPath));

  test(`webkit renders the ${sliceId} and captures named states`, async ({ page }, testInfo) => {
    const { server, url } = await startServer();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await assertSectionIdsAndNoHorizontalScroll(page, ids);
      await assertCspMeta(page);

      for (const { id, stateName, capture } of states) {
        const section = page.locator(`#${id}`);
        await section.scrollIntoViewIfNeeded();
        await expect(section).toBeVisible();
        if (!capture) continue;
        await captureNamedUiState({
          page,
          testInfo,
          sliceId,
          stateName,
          // Frame each capture on the in-view section, not the whole scroll
          // document, so the designer-review loop sees one state per artifact.
          fullPage: false,
          metadata: {
            fixture: deckName,
            route: `#${id}`,
            reviewHint: `Designer-review state for the "${id}" deck section.`,
          },
        });
      }
    } finally {
      await stopFixtureServer(server);
    }
  });

  test(`webkit ${sliceId} fits the mobile viewport (no horizontal scroll, no vertical clip)`, async ({ page }, testInfo) => {
    const { server, url } = await startServer();
    try {
      await settleMobile(page, url);
      const m = await measureFit(page);
      assertMobileFit(m);

      const section = page.locator(`#${mobileCapture.id}`);
      await section.scrollIntoViewIfNeeded();
      await expect(section).toBeVisible();
      await captureNamedUiState({
        page,
        testInfo,
        sliceId,
        stateName: `${mobileCapture.stateName} (mobile 390)`,
        fullPage: false,
        metadata: {
          fixture: deckName,
          route: `#${mobileCapture.id}`,
          reviewHint: `Mobile (390x844) layout for the ${mobileCapture.id} section — fits the viewport, no scroll/clip.`,
        },
      });
    } finally {
      await stopFixtureServer(server);
    }
  });

  // Guard the guard: a deliberately-wide element MUST be caught by the fit check.
  test(`${sliceId} mobile fit check fails on a deliberately-wide element`, async ({ page }) => {
    const { server, url } = await startServer();
    try {
      await settleMobile(page, url);
      await page.evaluate(() => {
        const wide = document.createElement("div");
        wide.style.cssText = "width:1200px;height:10px";
        document.body.appendChild(wide);
      });
      const m = await measureFit(page);
      expect(m.hOffenders.length).toBeGreaterThan(0);
    } finally {
      await stopFixtureServer(server);
    }
  });
}

// The deck registry. Each deck is data — adding a deck is one entry here plus a
// thin spec that calls defineDeckSuite(DECK_REGISTRY.<key>).
export const DECK_REGISTRY = {
  "intro-deck": {
    sliceId: "intro-deck",
    deck: "introducing-dev-loops.html",
    mobileCapture: { id: "compounding", stateName: "Compounding" },
    sectionIds: [
      { id: "hero", stateName: "Hero" },
      { id: "coordination-cost", stateName: "Coordination cost" },
      { id: "compounding", stateName: "Compounding" },
      { id: "the-loop", stateName: "The loop" },
      { id: "the-work", stateName: "The work" },
      { id: "model-agnostic", stateName: "Model agnostic" },
      { id: "proof", stateName: "Proof (data)" },
      { id: "setup", stateName: "Setup" },
      { id: "close", stateName: "Close" },
    ],
  },
  "deep-dive-deck": {
    sliceId: "deep-dive-deck",
    deck: "dev-loops-deep-dive.html",
    mobileCapture: { id: "core-idea", stateName: "Core idea" },
    sectionIds: [
      { id: "hero", stateName: "Hero", capture: true },
      // Part 1 — eliminating coordination delay
      { id: "core-idea", stateName: "Core idea", capture: true },
      { id: "safe-pauses", stateName: "Safe pauses", capture: false },
      { id: "steering", stateName: "Steering", capture: false },
      { id: "parallel-review", stateName: "Parallel review", capture: true },
      { id: "trust", stateName: "Trust / never-lie", capture: false },
      { id: "why-graphs", stateName: "Why graphs", capture: true },
      // Part 2 — make the waiting visible
      { id: "interrupt-cost", stateName: "Interrupt cost (delay pattern)", capture: true },
      { id: "handoff", stateName: "Handoff cost", capture: false },
      { id: "blind-spot", stateName: "Blind spot", capture: false },
      { id: "observable-state", stateName: "Observable state", capture: true },
      { id: "measurement-loop", stateName: "Measurement loop", capture: true },
      { id: "instrumented", stateName: "Instrumented", capture: true },
      { id: "metrics", stateName: "Metrics", capture: false },
      { id: "close", stateName: "Close", capture: true },
    ],
  },
};

// Resolve a registry entry with a clear message so a mistyped/removed key fails
// at module load pointing straight at the missing deck, not an opaque
// "Cannot read properties of undefined (reading 'deck')".
export function deckRegistryEntry(key) {
  const entry = DECK_REGISTRY[key];
  if (!entry) {
    throw new Error(
      `Unknown deck registry key "${key}". Known keys: ${Object.keys(DECK_REGISTRY).join(", ")}`,
    );
  }
  return entry;
}
