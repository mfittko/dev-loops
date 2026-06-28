import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { test, expect } from "@playwright/test";

import { captureNamedUiState, startFixtureServer, stopFixtureServer } from "./harness/webkit-smoke-harness.mjs";

const DECK_PATH = fileURLToPath(new URL("../../docs/presentations/introducing-dev-loops.html", import.meta.url));

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

// The named states the designer/vision review loop targets. Each must be a
// stable <section id> in the rendered deck.
const NAMED_STATES = [
  { id: "hero", stateName: "Hero" },
  { id: "coordination-cost", stateName: "Coordination cost" },
  { id: "compounding", stateName: "Compounding" },
  { id: "the-loop", stateName: "The loop" },
  { id: "the-work", stateName: "The work" },
  { id: "model-agnostic", stateName: "Model agnostic" },
  { id: "proof", stateName: "Proof (data)" },
  { id: "setup", stateName: "Setup" },
  { id: "close", stateName: "Close" },
];

test("webkit renders the intro deck and captures named states", async ({ page }, testInfo) => {
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

    for (const { id, stateName } of NAMED_STATES) {
      const section = page.locator(`#${id}`);
      await section.scrollIntoViewIfNeeded();
      await expect(section).toBeVisible();

      await captureNamedUiState({
        page,
        testInfo,
        sliceId: "intro-deck",
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

// Mobile pass: enforce that content FITS — no horizontal scroll anywhere, and
// no `<section>` whose own overflow-y is hidden/clip while its content is taller
// than its box (the vertical-clip check below is per-section, not an ancestor walk). Settle the
// layout (viewport applied, fonts loaded, network idle) before measuring so the
// cold-start false-fail — measuring desktop ~815px geometry — can't happen.
const MOBILE = { width: 390, height: 844 };

async function settleMobile(page, url) {
  await page.setViewportSize(MOBILE);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
  await page.waitForFunction((w) => window.innerWidth === w, MOBILE.width);
  await page.evaluate(() => document.fonts.ready);
}

// Returns { hOffenders, pageScrollWidth, innerWidth, clipped } measured after settle.
async function measureFit(page) {
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

test("webkit intro deck fits the mobile viewport (no horizontal scroll, no vertical clip)", async ({ page }, testInfo) => {
  const { server, url } = await startFixtureServer(makeDeckServer);

  try {
    await settleMobile(page, url);
    const m = await measureFit(page);

    // Authoritative horizontal-fit guard: per-element getBoundingClientRect().right
    // is clip-independent, so it catches overflow even though body{overflow-x:hidden}.
    expect(m.hOffenders, `elements overflow the ${MOBILE.width}px viewport (must FIT, not scroll):\n${m.hOffenders.join("\n")}`).toEqual([]);
    // Defensive secondary: body{overflow-x:hidden} clips page-level growth, so this
    // line rarely fires on its own — the per-element check above is the real catch.
    expect(m.pageScrollWidth, "page scrollWidth exceeds the viewport (defensive check)").toBeLessThanOrEqual(m.innerWidth + 1);
    expect(m.clipped, `sections clip content with overflow:hidden (taller than their box):\n${m.clipped.join("\n")}`).toEqual([]);

    // Capture one mobile state so the review loop sees the phone layout.
    const compounding = page.locator("#compounding");
    await compounding.scrollIntoViewIfNeeded();
    await expect(compounding).toBeVisible();
    await captureNamedUiState({
      page,
      testInfo,
      sliceId: "intro-deck",
      stateName: "Compounding (mobile 390)",
      fullPage: false,
      metadata: {
        fixture: path.basename(DECK_PATH),
        route: "#compounding",
        reviewHint: "Mobile (390x844) layout for the compounding section — fits the viewport, no scroll/clip.",
      },
    });
  } finally {
    await stopFixtureServer(server);
  }
});

// Guard the guard: a deliberately-wide element MUST be caught by the fit check.
test("mobile fit check fails on a deliberately-wide element", async ({ page }) => {
  const { server, url } = await startFixtureServer(makeDeckServer);

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
