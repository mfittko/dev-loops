import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

import { createInspectRunViewerServer } from "../../scripts/loop/inspect-run-viewer.mjs";
import { startFixtureServer, stopFixtureServer } from "./harness/webkit-smoke-harness.mjs";
import { assertA11yClean, assertSectionIdsAndNoHorizontalScroll } from "./harness/deck-fit-harness.mjs";
import {
  VIEWER_REGISTRY,
  captureViewerState,
  makeInspectionSnapshot,
  openTab,
  startViewer,
  waitForInspectionGraph,
} from "./harness/inspect-run-viewer-harness.mjs";

// Each case owns its browser page, binds its fixture server to an ephemeral
// port, and writes through Playwright's testInfo-scoped artifact paths.
// The overview case renders the largest graph and can cross the global 30s
// ceiling on a contended hosted runner while the second worker is active.
test.describe.configure({ mode: "parallel", timeout: 45_000 });

test("initial hidden-tab activation centers the current state", async ({ page }, testInfo) => {
  const { server, url } = await startViewer();
  try {
    await page.goto(url);
    await expect(page.locator("#tab-overview")).toHaveClass(/active/);
    await openTab(page, "graph");
    const graph = await waitForInspectionGraph(page);
    const current = graph.locator(".inspection-graph-node.current");
    const currentBox = await current.boundingBox();
    const viewportBox = await graph.boundingBox();
    if (!currentBox || !viewportBox) throw new Error("Current state or graph viewport is not rendered");
    expect(Math.abs(currentBox.x + currentBox.width / 2 - viewportBox.x - viewportBox.width / 2)).toBeLessThan(1);
    expect(Math.abs(currentBox.y + currentBox.height / 2 - viewportBox.y - viewportBox.height / 2)).toBeLessThan(1);
    await captureViewerState(page, testInfo, "default current focus", "Initial known state stays centered at a readable scale after the hidden graph tab opens.", { interactionState: "none" });
  } finally {
    await stopFixtureServer(server);
  }
});

test("feedback styling follows horizontal graph direction, not vertical position", async ({ page }) => {
  const { server, url } = await startViewer();
  try {
    await page.goto(url);
    await openTab(page, "graph");
    const graph = await waitForInspectionGraph(page);
    const layer = (await readGraph(page)).layers.find((entry) => entry.id === "lifecycle_layer");
    const positions = new Map(layer.geometry.nodes.map((node) => [node.id, node]));
    const forward = layer.edges.find((edge) => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      return to.x > from.x && to.y <= from.y;
    });
    const backward = layer.edges.find((edge) => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      return to.x < from.x && to.y > from.y;
    });
    expect(forward, "A forward edge rising vertically exercises the direction boundary").toBeDefined();
    expect(backward, "A feedback edge falling vertically exercises the direction boundary").toBeDefined();
    await expect(graph.locator(`[data-edge-id="${forward.id}"]`)).not.toHaveClass(/\bfeedback\b/);
    await expect(graph.locator(`[data-edge-id="${backward.id}"]`)).toHaveClass(/\bfeedback\b/);
  } finally {
    await stopFixtureServer(server);
  }
});

test("wide graph text stays inside cards without losing labels or identifiers", async ({ page }, testInfo) => {
  const { server, url } = await startViewer();
  try {
    await page.route(`${url}/`, async (route) => {
      const response = await route.fetch();
      const { layoutInspectionLayer } = await import("../../scripts/loop/inspect-run-viewer/graph-layout.mjs");
      const body = (await response.text()).replace(/(<script\b[^>]*data-inspection-graph-data[^>]*>)([\s\S]*?)(<\/script>)/, (_, start, json, end) => {
        const model = JSON.parse(json);
        const layer = model.layers.find((entry) => entry.id === "lifecycle_layer");
        ["W", "長", "😀"].forEach((character, index) => {
          layer.nodes[index].label = character.repeat(90);
          layer.nodes[index].stateId = character.repeat(90);
        });
        layer.cues[0].label = "W".repeat(32);
        layer.geometry = layoutInspectionLayer(layer);
        return start + JSON.stringify(model).replaceAll("<", "\\u003c") + end;
      });
      await route.fulfill({ response, body });
    });
    await page.goto(url);
    await openTab(page, "graph");
    const graph = await waitForInspectionGraph(page);
    const textBounds = await graph.locator(".inspection-graph-node, .inspection-graph-cue").evaluateAll((cards) => cards.flatMap((card) => {
      const width = card.querySelector("rect").width.baseVal.value;
      return [...card.querySelectorAll("text")].map((text) => {
        const bounds = text.getBBox();
        return { text: text.textContent, left: bounds.x, right: bounds.x + bounds.width, availableRight: width - 16 };
      });
    }));
    expect(textBounds.filter((text) => text.left < 15.5 || text.right > text.availableRight + 0.5)).toEqual([]);
    for (const character of ["W", "長", "😀"]) {
      const card = graph.locator(`[data-state-id="${character.repeat(90)}"]`);
      expect((await card.locator(".inspection-graph-label").allTextContents()).join("")).toBe(character.repeat(90));
      expect((await card.locator(".inspection-graph-state-id").allTextContents()).join("")).toBe(character.repeat(90));
    }
    await captureViewerState(page, testInfo, "Wide graph text boundary", "Wide Latin, CJK and emoji text wraps losslessly within state and presentation-cue cards.");
  } finally {
    await stopFixtureServer(server);
  }
});

test("resizing preserves current focus, fitted bounds and deliberate camera pan", async ({ page }, testInfo) => {
  const { server, url } = await startViewer();
  try {
    await page.goto(url);
    await openTab(page, "graph");
    const graph = await waitForInspectionGraph(page);
    const root = page.locator("[data-inspection-graph-root]");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(async () => {
      const current = await graph.locator(".inspection-graph-node.current").boundingBox();
      const viewport = await graph.boundingBox();
      return Math.abs(current.x + current.width / 2 - viewport.x - viewport.width / 2);
    }).toBeLessThan(1);
    await root.locator("[data-graph-fit]").click();
    await page.setViewportSize({ width: 640, height: 720 });
    const bounds = (await readGraph(page)).layers.find((entry) => entry.id === "lifecycle_layer").geometry.bounds;
    await expect.poll(() => graph.evaluate((viewport, bounds) => {
      const matrix = viewport.querySelector(".inspection-graph-world").transform.baseVal.consolidate().matrix;
      return Math.max(
        Math.abs((bounds.x + bounds.width / 2) * matrix.a + matrix.e - viewport.clientWidth / 2),
        Math.abs((bounds.y + bounds.height / 2) * matrix.d + matrix.f - viewport.clientHeight / 2),
      );
    }, bounds)).toBeLessThan(1);
    await graph.focus();
    await graph.press("ArrowRight");
    const cameraCenter = () => graph.evaluate((viewport) => {
      const matrix = viewport.querySelector(".inspection-graph-world").transform.baseVal.consolidate().matrix;
      return { x: (viewport.clientWidth / 2 - matrix.e) / matrix.a, y: (viewport.clientHeight / 2 - matrix.f) / matrix.d, scale: matrix.a };
    });
    const panned = await cameraCenter();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(async () => {
      const resized = await cameraCenter();
      return Math.max(Math.abs(resized.x - panned.x), Math.abs(resized.y - panned.y), Math.abs(resized.scale - panned.scale));
    }).toBeLessThan(0.001);
    await captureViewerState(page, testInfo, "Resized camera with deliberate pan", "Viewport changes preserve the active focus/fit intent or the deliberately panned world-space center.");
  } finally {
    await stopFixtureServer(server);
  }
});

test("Focus scale is captured at click and independent of resize history", async ({ page }) => {
  const { server, url } = await startViewer();
  try {
    await page.goto(url);
    await openTab(page, "graph");
    const graph = await waitForInspectionGraph(page);
    const root = page.locator("[data-inspection-graph-root]");
    const scale = () => graph.evaluate((viewport) => viewport.querySelector(".inspection-graph-world").transform.baseVal.consolidate().matrix.a);
    await root.locator("[data-graph-focus]").click();
    const first = await scale();
    for (const size of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
      await page.setViewportSize(size);
    }
    await expect.poll(async () => Math.abs((await scale()) - first)).toBeLessThan(0.001);
  } finally {
    await stopFixtureServer(server);
  }
});

test("viewer keeps a consistent light theme under a dark system preference", async ({ page }, testInfo) => {
  const { server, url } = await startViewer();
  try {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(url);
    await openTab(page, "graph");
    await waitForInspectionGraph(page);
    const surfaces = await page.locator("body, .state-graph-frame, [data-graph-viewport], [data-graph-layer][aria-pressed='true']").evaluateAll((elements) => elements.map((element) => {
      const channels = getComputedStyle(element).backgroundColor.match(/[\d.]+/g).slice(0, 3).map((channel) => Number(channel) / 255);
      const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
      return { surface: element.tagName, luminance: 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2] };
    }));
    expect(surfaces.filter((surface) => surface.luminance < 0.75)).toEqual([]);
    expect(await page.locator(".assigned-pr-select").first().evaluate((control) => getComputedStyle(control).colorScheme)).toBe("light");
    await captureViewerState(page, testInfo, "Light theme with dark system preference", "Shell, graph, selected layer and native controls use the same light theme despite a dark OS preference.");
  } finally {
    await stopFixtureServer(server);
  }
});

test("webkit renders overview-first tabs, matches tab panels, and captures a screenshot", async ({ page }, testInfo) => {
  const { server, url } = await startViewer(makeInspectionSnapshot(), [
    { target: { repo: "other/repo", pr: 77 }, title: "Waiting PR", signal: "attention" },
    ...Array.from({ length: 26 }, (_, index) => ({
      target: { repo: `other/repo-${index + 1}`, pr: 200 + index },
      title: `Extra PR ${index + 1}`,
      signal: "waiting",
    })),
  ]);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // Shared structural guard: the dashboard's registered panel ids are present
    // exactly once and the layout has no sideways scroll.
    await assertSectionIdsAndNoHorizontalScroll(page, VIEWER_REGISTRY.sectionIds);

    await expect(page.getByRole("link", { name: "owner/repo#55" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Current PR" })).toBeVisible();
    const currentStateBanner = page.locator('section[aria-label="PR #55"]');
    await expect(currentStateBanner).toBeVisible();
    await expect(currentStateBanner.getByTitle("Waiting state")).toBeVisible();
    await expect(currentStateBanner.getByText("Waiting for Copilot review")).toBeVisible();
    const tabs = await page.locator('.viewer-tab').evaluateAll((nodes) => nodes.map((node) => ({
      text: node.textContent?.trim() ?? '',
      id: node.id,
      controls: node.getAttribute('aria-controls'),
      active: node.classList.contains('active'),
    })));
    expect(tabs).toEqual([
      { text: 'Overview', id: 'tab-btn-overview', controls: 'tab-overview', active: true },
      { text: 'Graph', id: 'tab-btn-graph', controls: 'tab-graph', active: false },
      { text: 'Layers', id: 'tab-btn-layers', controls: 'tab-layers', active: false },
      { text: 'Agent handoff', id: 'tab-btn-handoff', controls: 'tab-handoff', active: false },
    ]);
    const panels = await page.locator('.tab-content').evaluateAll((nodes) => nodes.map((node) => ({
      id: node.id,
      labelledBy: node.getAttribute('aria-labelledby'),
    })));
    expect(panels).toEqual([
      { id: 'tab-overview', labelledBy: 'tab-btn-overview' },
      { id: 'tab-graph', labelledBy: 'tab-btn-graph' },
      { id: 'tab-layers', labelledBy: 'tab-btn-layers' },
      { id: 'tab-handoff', labelledBy: 'tab-btn-handoff' },
    ]);
    const overviewPanel = page.locator('#tab-overview');
    await expect(overviewPanel).toHaveClass(/active/);
    await expect(overviewPanel.locator('.viewer-card-grid-overview')).toBeVisible();
    await expect(overviewPanel.getByText('Current state')).toBeVisible();
    await expect(overviewPanel.getByText('Next action and key metrics')).toBeVisible();
    const sidebar = page.locator(".assigned-pr-inbox");
    await expect(page.getByRole("heading", { name: "PR inspection dashboard" })).toBeVisible();
    await expect(page.getByLabel("Assignment mode")).toBeVisible();
    await expect(page.getByLabel("Updated window")).toBeVisible();
    const sidebarToggle = page.locator("[data-inbox-toggle]");
    await expect(sidebarToggle).toHaveText("◀");
    await sidebarToggle.click();
    await expect(sidebar).toHaveAttribute("data-sidebar-collapsed", "true");
    await expect(sidebarToggle).toHaveAttribute("aria-expanded", "false");
    await expect(sidebarToggle).toHaveText("▶");
    await sidebarToggle.click();
    await expect(sidebar).toHaveAttribute("data-sidebar-collapsed", "false");

    await expect(page.locator('.assigned-pr-title-indicator')).toHaveCount(0);
    const paginationAfterList = await page.locator('.assigned-pr-inbox').evaluate((node) => {
      const list = node.querySelector('.assigned-pr-list');
      const pagination = node.querySelector('.assigned-pr-pagination');
      return Boolean(list && pagination && (list.compareDocumentPosition(pagination) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    expect(paginationAfterList).toBeTruthy();

    await page.getByRole('link', { name: 'Next page' }).click();
    await expect(page.locator('.assigned-pr-page-status')).toHaveText('2/2');
    await expect(page.getByRole('heading', { name: 'Current PR' })).toBeVisible();
    await expect(page.locator('[aria-current="page"]')).toHaveCount(0);
    await page.getByRole('link', { name: 'Previous page' }).click();
    await expect(page.locator('.assigned-pr-page-status')).toHaveText('1/2');

    const inboxSearch = page.locator("[data-inbox-search]");
    const inboxList = page.locator('.assigned-pr-list');
    await inboxSearch.fill("other/repo");
    await expect(inboxList.getByRole("link", { name: /Waiting PR/ })).toBeVisible();
    await expect(inboxList.getByRole("link", { name: /Current PR/ })).toBeHidden();
    await inboxSearch.fill("no matches here");
    await expect(page.locator("[data-inbox-empty]")).toBeVisible();
    await inboxSearch.fill("");
    await expect(page.locator("[data-inbox-empty]")).toBeHidden();
    await expect(inboxList.getByRole("link", { name: /Current PR/ })).toBeVisible();

    await openTab(page, "graph");
    const graph = await waitForInspectionGraph(page);
    const root = page.locator("[data-inspection-graph-root]");
    await expect(root).toHaveAttribute("data-selected-layer", "lifecycle_layer");
    await expect(root.locator("[data-graph-layer]")).toHaveCount(4);
    await expect(graph.locator('[data-state-id="implementation"]')).toHaveClass(/current/);
    await expect(graph.locator(".inspection-graph-node.next")).toHaveCount(2);
    await expect(root.locator("[data-graph-node-details]")).toContainText("implementation");
    await openTab(page, 'layers');
    await expect(page.locator('#tab-layers')).toHaveClass(/active/);
    await expect(page.locator('#tab-layers')).toContainText(/Outer-loop/);
    await expect(page.locator('#tab-layers')).toContainText(/Copilot/);

    await openTab(page, 'handoff');
    await expect(page.locator('#tab-handoff')).toHaveClass(/active/);
    await expect(page.locator('#handoff-envelope-section')).toBeVisible();
    await expect(page.locator('#handoff-envelope-section')).toContainText(/Agent handoff/);

    await openTab(page, 'overview');
    await expect(page.locator('#tab-overview')).toHaveClass(/active/);
    await expect(page.locator('#tab-overview .viewer-card-grid-overview')).toBeVisible();

    await captureViewerState(page, testInfo, "Current PR dashboard", "Use this state for the reusable dashboard smoke baseline.");
  } finally {
    await stopFixtureServer(server);
  }
});

test("unknown current identifiers stay unavailable rather than selecting a known state", async ({ page }, testInfo) => {
  const { server, url } = await startViewer(makeInspectionSnapshot({
    lifecyclePhase: "unrecognized_state",
    lifecycleAllowedTransitions: undefined,
  }));
  try {
    await page.goto(url);
    await openTab(page, "graph");
    const graph = await waitForInspectionGraph(page);
    const root = page.locator("[data-inspection-graph-root]");
    await expect(root).toHaveAttribute("data-selected-layer", "lifecycle_layer");
    await expect(graph.locator(".inspection-graph-node.current")).toHaveCount(0);
    await expect(root.locator("[data-graph-focus]")).toBeDisabled();
    await expect(root.locator("[data-graph-status]")).toContainText(/unavailable|unknown/i);
    await expect(root).toContainText("unrecognized_state");
    await assertA11yClean(await new AxeBuilder({ page }).analyze());
    await captureViewerState(page, testInfo, "Unknown current state", "No executable node is invented or selected as current.");
  } finally {
    await stopFixtureServer(server);
  }
});

test("terminal current and snapshot availability remain independent", async ({ page }, testInfo) => {
  const { server, url } = await startViewer(makeInspectionSnapshot({
    outerState: "done_terminal", statusClass: "done", outerAction: "done",
    layers: { copilot: { currentState: "done", allowedTransitions: [] } },
  }));
  try {
    await page.goto(url);
    await expect(page.locator('section[aria-label="PR #55"]')).toContainText("PR complete");
    await openTab(page, "graph");
    const graph = await waitForInspectionGraph(page);
    const root = page.locator("[data-inspection-graph-root]");
    await root.locator('[data-graph-layer="copilot_layer"]').click();
    const done = graph.locator('[data-state-id="done"]');
    await expect(done).toHaveClass(/current/);
    await expect(done).toHaveClass(/terminal/);
    await done.focus();
    await done.press("Enter");
    await expect(root.locator("[data-graph-node-details]")).toContainText(/Current/);
    await expect(root.locator("[data-graph-node-details]")).toContainText(/Terminal/);
    await expect(root.locator("[data-graph-node-details]")).toContainText(/empty|no allowed/i);
    await captureViewerState(page, testInfo, "Terminal current state", "Current and terminal are both visible, independent of empty eligibility.");
  } finally {
    await stopFixtureServer(server);
  }
});

test("unavailable snapshots preserve the raw snapshot escape hatch", async ({ page }, testInfo) => {
  const { server, url } = await startViewer(makeInspectionSnapshot({ sourceMode: "unavailable", trust: "unknown" }));
  try {
    await page.goto(url);
    await openTab(page, "graph");
    await expect(page.locator("#tab-graph svg")).toHaveCount(0);
    await expect(page.locator("#tab-graph")).toContainText(/unavailable/i);
    await expect(page.locator('#tab-graph a[href*="/snapshot.json"]')).toBeVisible();
    await assertA11yClean(await new AxeBuilder({ page }).analyze());
    await captureViewerState(page, testInfo, "Unavailable snapshot fallback", "Text and raw snapshot access remain available without a graph.");
  } finally {
    await stopFixtureServer(server);
  }
});

const LAYERS = ["outer_loop_family", "copilot_layer", "reviewer_layer", "lifecycle_layer"];

async function readGraph(page) {
  return page.locator("[data-inspection-graph-data]").evaluate((node) => JSON.parse(node.textContent));
}

async function camera(graph) {
  return graph.locator(".inspection-graph-world").getAttribute("transform");
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  for (const theme of ["light", "dark"]) {
    test(`all layers remain readable at ${viewport.width}px in ${theme}`, async ({ page }, testInfo) => {
      const { server, url } = await startViewer();
      try {
        await page.setViewportSize(viewport);
        await page.emulateMedia({ colorScheme: theme });
        const asset = page.waitForResponse((response) => response.url().endsWith("/assets/inspect-graph.mjs"));
        await page.goto(url);
        const response = await asset;
        expect(response.ok()).toBe(true);
        expect(response.headers()["content-type"]).toMatch(/javascript/);
        expect(response.headers()["cache-control"]).toContain("no-store");
        await openTab(page, "graph");
        const graph = await waitForInspectionGraph(page);
        const root = page.locator("[data-inspection-graph-root]");
        const model = await readGraph(page);
        for (const id of LAYERS) {
          await root.locator(`[data-graph-layer="${id}"]`).click();
          await expect(root).toHaveAttribute("data-selected-layer", id);
          for (const layerId of LAYERS) await expect(root.locator(`[data-graph-layer="${layerId}"]`)).toBeVisible();
          const layer = model.layers.find((entry) => entry.id === id);
          expect(await graph.locator("[data-node-id]").evaluateAll((nodes) => nodes.map((node) => node.dataset.nodeId).sort()))
            .toEqual(layer.nodes.map((node) => node.id).sort());
          expect(await graph.locator("[data-edge-id]").evaluateAll((nodes) => nodes.map((node) => node.dataset.edgeId).sort()))
            .toEqual(layer.edges.map((edge) => edge.id).sort());
          await assertSectionIdsAndNoHorizontalScroll(page, VIEWER_REGISTRY.sectionIds);
          await assertA11yClean(await new AxeBuilder({ page }).analyze());
          await captureViewerState(page, testInfo, `${theme} ${id}`, "Review readable current-state focus, persistent summaries and nearby directed paths.", { interactionState: "none" });
          await root.locator("[data-graph-fit]").click();
          await captureViewerState(page, testInfo, `${theme} ${id} fit overview`, "Review complete topology bounds and unclipped feedback paths; use Focus or zoom to read individual states.", { interactionState: "none" });
        }
        await root.locator('[data-graph-layer="lifecycle_layer"]').click();
        await root.locator("[data-graph-focus]").click();
        const current = graph.locator('[data-state-id="implementation"]');
        await current.focus();
        await expect(current).toBeFocused();
        await current.press("Space");
        await expect(current).toHaveAttribute("aria-pressed", "true");
        await captureViewerState(page, testInfo, `${theme} keyboard node focus`, "Review visible focus, current chip and readable state details.", { interactionState: "focus" });
        await root.locator("[data-graph-fit]").click();
        const lifecycle = model.layers.find((entry) => entry.id === "lifecycle_layer");
        const pointerIndex = lifecycle.nodes.findIndex((node) => node.stateId === "draft_gate");
        const pointerTarget = graph.locator('[data-state-id="draft_gate"]');
        await current.focus();
        await pointerTarget.click();
        await expect(pointerTarget).toBeFocused();
        await page.keyboard.press("ArrowRight");
        await expect(graph.locator(".inspection-graph-node.selected")).toHaveAttribute("data-node-id", lifecycle.nodes[(pointerIndex + 1) % lifecycle.nodes.length].id);
        const selectedNode = graph.locator(".inspection-graph-node.selected");
        await page.keyboard.press("End");
        await expect(selectedNode).toHaveAttribute("data-node-id", lifecycle.nodes.at(-1).id);
        await page.keyboard.press("Home");
        await expect(selectedNode).toHaveAttribute("data-node-id", lifecycle.nodes[0].id);
        await page.keyboard.press("ArrowLeft");
        await expect(selectedNode).toHaveAttribute("data-node-id", lifecycle.nodes.at(-1).id);
        await captureViewerState(page, testInfo, `${theme} pointer keyboard transition`, "Pointer selection and subsequent arrow-key navigation stay on the selected card.", { interactionState: "focus" });
      } finally {
        await stopFixtureServer(server);
      }
    });
  }
}

test("selection, camera and pointer gestures are read-only and preserve authoritative geometry", async ({ page }, testInfo) => {
  const { server, url } = await startViewer();
  const requests = [];
  page.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));
  try {
    await page.goto(url);
    await openTab(page, "graph");
    const graph = await waitForInspectionGraph(page);
    const root = page.locator("[data-inspection-graph-root]");
    const model = await readGraph(page);
    const layer = model.layers.find((entry) => entry.id === "lifecycle_layer");
    const current = graph.locator('[data-state-id="implementation"]');
    await current.focus();
    await current.press("Enter");
    const details = root.locator("[data-graph-node-details]");
    await expect(details).toContainText(/Authoritative outgoing transitions/);
    await expect(details).toContainText(/Snapshot/);
    const outgoingIds = layer.edges.filter((edge) => edge.from === layer.current.nodeId).map((edge) => layer.nodes.find((node) => node.id === edge.to).stateId);
    for (const state of outgoingIds) await expect(details).toContainText(state);
    const geometry = await graph.locator("[data-node-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("transform")));
    await root.locator("[data-graph-fit]").click();
    const fit = await camera(graph);
    await root.locator("[data-graph-reset]").click();
    await expect(root.locator("[data-graph-zoom-value]")).toHaveText("100%");
    expect(await camera(graph)).not.toBe(fit);
    await expect(current).toHaveAttribute("aria-pressed", "true");
    await root.locator("[data-graph-zoom-in]").click();
    expect(Number(await graph.getAttribute("data-graph-scale"))).toBeGreaterThan(1);
    await root.locator("[data-graph-zoom-out]").click();
    await graph.focus();
    const beforePan = await camera(graph);
    await graph.press("ArrowRight");
    expect(await camera(graph)).not.toBe(beforePan);
    const beforeTabs = await camera(graph);
    await openTab(page, "layers");
    await openTab(page, "graph");
    await page.evaluate(() => {
      document.dispatchEvent(new CustomEvent("inspect-run-viewer:tabchange", { detail: { tabName: "overview" } }));
      document.dispatchEvent(new CustomEvent("inspect-run-viewer:tabchange", { detail: { tabName: "graph" } }));
    });
    expect(await camera(graph)).toBe(beforeTabs);
    const selection = await details.textContent();
    await graph.evaluate((node) => {
      const fire = (type, pointerId, button, x) => node.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId, button, clientX: x, clientY: 100 }));
      fire("pointerdown", 4, 2, 100);
      fire("pointermove", 4, 2, 160);
      fire("pointerup", 4, 2, 160);
      fire("pointerdown", 5, 0, 100);
      fire("pointermove", 5, 0, 102);
      fire("pointerup", 5, 0, 102);
    });
    expect(await camera(graph)).toBe(beforeTabs);
    await graph.evaluate((node) => {
      const fire = (type, pointerId, x, y) => node.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId, button: 0, clientX: x, clientY: y }));
      fire("pointerdown", 7, 100, 100);
      fire("pointermove", 8, 160, 140);
      fire("pointerup", 8, 160, 140);
    });
    expect(await camera(graph)).toBe(beforeTabs);
    await graph.evaluate((node) => {
      node.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 7 }));
      node.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 7, clientX: 200, clientY: 200 }));
    });
    expect(await camera(graph)).toBe(beforeTabs);
    await graph.evaluate((node) => {
      const fire = (type, x, y) => node.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 9, button: 0, clientX: x, clientY: y }));
      fire("pointerdown", 100, 100);
      fire("pointermove", 145, 120);
      fire("pointerup", 145, 120);
      node.querySelector('[data-state-id="draft_gate"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(await camera(graph)).not.toBe(beforeTabs);
    expect(await details.textContent()).toBe(selection);
    const box = await graph.boundingBox();
    await page.mouse.move(box.x + box.width - 10, box.y + box.height - 10);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 80, box.y + box.height - 50, { steps: 5 });
    await page.mouse.up();
    await root.locator("[data-graph-focus]").click();
    expect(await graph.locator("[data-node-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("transform")))).toEqual(geometry);
    await root.locator("[data-graph-fit]").click();
    expect(await camera(graph)).toBe(fit);
    expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
    expect(requests.filter((request) => new URL(request.url).pathname === "/snapshot.json")).toEqual([]);
    expect(requests.filter((request) => new URL(request.url).pathname.startsWith("/assets/"))).toEqual([
      { method: "GET", url: `${url}/assets/inspect-graph.mjs` },
    ]);
    await captureViewerState(page, testInfo, "Read only camera interaction", "Fit restored without changing topology, selection or runtime.");
  } finally {
    await stopFixtureServer(server);
  }
});

for (const fullscreenMode of ["native", "unsupported", "rejected"]) {
  test(`fullscreen ${fullscreenMode} has visible exit and restores focus`, async ({ page }, testInfo) => {
    const { server, url } = await startViewer();
    try {
      if (fullscreenMode !== "native") await page.addInitScript((mode) => {
        Object.defineProperty(Element.prototype, "requestFullscreen", { configurable: true, value: mode === "unsupported" ? undefined : () => Promise.reject(new Error("denied")) });
      }, fullscreenMode);
      await page.goto(url);
      await openTab(page, "graph");
      await waitForInspectionGraph(page);
      const root = page.locator("[data-inspection-graph-root]");
      const toggle = root.locator("[data-graph-fullscreen]");
      await toggle.click();
      await expect(toggle).toHaveAccessibleName(/Exit (fullscreen|expanded)/i);
      if (fullscreenMode !== "native") {
        await expect(root).toHaveClass(/expanded-graph-view/);
        await expect(toggle).toHaveAccessibleName(/expanded/i);
        expect(await page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
        // Tab focus trap: wrap forward from the last and backward from the first focusable control.
        const edgeState = (focusEdge) => page.evaluate((which) => {
          const list = [...document.querySelector("[data-inspection-graph-root]").querySelectorAll('button:not(:disabled), a[href], [tabindex="0"], summary')].filter((element) => element.getClientRects().length);
          const focused = list.indexOf(document.activeElement);
          if (which === "last") list.at(-1).focus();
          return { focused, last: list.length - 1 };
        }, focusEdge);
        await edgeState("last");
        await page.keyboard.press("Tab");
        expect((await edgeState(null)).focused).toBe(0);
        await page.keyboard.press("Shift+Tab");
        const afterReverse = await edgeState(null);
        expect(afterReverse.focused).toBe(afterReverse.last);
      }
      await expect(toggle).toBeVisible();
      await captureViewerState(page, testInfo, `${fullscreenMode} full graph view`, "Exit and layer summaries stay usable; fallback never claims native fullscreen.");
      await page.keyboard.press("Escape");
      await expect(toggle).toHaveAccessibleName(/Open graph fullscreen/i);
      await expect(toggle).toBeFocused();
      await expect(root.locator("[data-graph-status]")).not.toContainText(/Expanded graph view/);
      await toggle.click();
      await expect(toggle).toHaveAccessibleName(/Exit (fullscreen|expanded)/i);
      await toggle.click();
      await expect(toggle).toHaveAccessibleName(/Open graph fullscreen/i);
    } finally {
      await stopFixtureServer(server);
    }
  });
}

test("manual reload projects changed snapshot without moving the authoritative layout", async ({ page }, testInfo) => {
  let snapshot = makeInspectionSnapshot();
  const { server, url } = await startViewer(() => snapshot);
  try {
    await page.goto(url);
    await openTab(page, "graph");
    const graph = await waitForInspectionGraph(page);
    const before = (await readGraph(page)).layers.map((layer) => layer.geometry);
    snapshot = makeInspectionSnapshot({ lifecyclePhase: "draft_gate", lifecycleAllowedTransitions: [] });
    await expect(graph.locator('[data-state-id="implementation"]')).toHaveClass(/current/);
    const reload = page.getByRole("button", { name: /Reload snapshot/i });
    const [refreshResponse] = await Promise.all([
      page.waitForResponse((response) => response.request().isNavigationRequest()
        && new URL(response.url()).pathname === "/" && new URL(response.url()).searchParams.get("refresh") === "1"),
      page.waitForEvent("domcontentloaded"),
      reload.click(),
    ]);
    expect(refreshResponse.ok()).toBe(true);
    await openTab(page, "graph");
    await waitForInspectionGraph(page);
    await expect(page.locator('[data-state-id="draft_gate"]')).toHaveClass(/current/);
    expect((await readGraph(page)).layers.map((layer) => layer.geometry)).toEqual(before);
    const response = await page.request.get(`${url}/snapshot.json?repo=owner%2Frepo&pr=55`);
    expect((await response.json()).lifecyclePhase).toBe("draft_gate");
    await captureViewerState(page, testInfo, "Manual changed snapshot reload", "New snapshot classification, unchanged layout and selected target.");
  } finally {
    await stopFixtureServer(server);
  }
});

test("snapshot strings are inert text, not markup or requests", async ({ page }, testInfo) => {
  const hostile = '</script><script>window.inspectAttack=true</script><img src="/attack" onerror="window.inspectAttack=true">';
  const { server, url } = await startViewer(makeInspectionSnapshot({ lifecyclePhase: hostile }));
  const attacks = [];
  page.on("request", (request) => { if (request.url().includes("/attack")) attacks.push(request.url()); });
  try {
    await page.goto(url);
    await openTab(page, "graph");
    await waitForInspectionGraph(page);
    await expect(page.locator("[data-inspection-graph-root]")).toContainText(hostile);
    expect(await page.evaluate(() => window.inspectAttack)).toBeUndefined();
    expect(attacks).toEqual([]);
    await expect(page.locator("#tab-graph img, #tab-graph foreignObject")).toHaveCount(0);
    await captureViewerState(page, testInfo, "Inert hostile snapshot text", "Unknown token is displayed literally and cannot escape the JSON payload.");
  } finally {
    await stopFixtureServer(server);
  }
});

for (const failure of ["asset", "geometry"]) {
  test(`${failure} failure retains text and disables ineffective graph controls`, async ({ page }, testInfo) => {
    const { server, url } = await startViewer();
    try {
      if (failure === "geometry") await page.addInitScript(() => {
        Object.defineProperty(Element.prototype, "requestFullscreen", { configurable: true, value: undefined });
      });
      if (failure === "asset") await page.route("**/assets/inspect-graph.mjs", (route) => route.abort());
      else await page.route(`${url}/`, async (route) => {
        const response = await route.fetch();
        const html = await response.text();
        const body = html.replace(/(<script\b[^>]*data-inspection-graph-data[^>]*>)([\s\S]*?)(<\/script>)/, (_, start, json, end) => {
          const model = JSON.parse(json);
          const layer = model.layers.find((entry) => entry.id === "copilot_layer");
          layer.geometry.nodes.pop();
          return start + JSON.stringify(model).replaceAll("<", "\\u003c") + end;
        });
        await route.fulfill({ response, body });
      });
      await page.goto(url);
      await openTab(page, "graph");
      const root = page.locator("[data-inspection-graph-root]");
      if (failure === "asset") {
        for (const id of LAYERS) await expect(root.locator(`[data-graph-layer="${id}"]`)).toBeDisabled();
      }
      if (failure === "geometry") {
        await waitForInspectionGraph(page);
        await root.locator("[data-graph-fullscreen]").click();
        await root.locator('[data-graph-layer="copilot_layer"]').click();
      }
      await expect(root.locator("svg")).toHaveCount(0);
      await expect(root.locator("[data-graph-status]")).toContainText(/unavailable|failed/i);
      for (const name of ["zoom-in", "zoom-out", "fit", "reset", "focus"]) await expect(root.locator(`[data-graph-${name}]`)).toBeDisabled();
      await expect(root.locator('a[href*="/snapshot.json"]')).toBeVisible();
      if (failure === "geometry") {
        await expect(root.locator("[data-graph-fullscreen]")).toBeEnabled();
        await root.locator("[data-graph-fullscreen]").click();
        await expect(root).not.toHaveClass(/expanded-graph-view/);
      }
      await expect(root).toContainText("implementation");
      await assertA11yClean(await new AxeBuilder({ page }).analyze());
      await captureViewerState(page, testInfo, `${failure} fallback`, "Authoritative text and snapshot link survive renderer failure.");
      if (failure === "geometry") {
        await root.locator('[data-graph-layer="lifecycle_layer"]').click();
        const graph = await waitForInspectionGraph(page);
        await expect(graph.locator('[data-state-id="implementation"]')).toHaveClass(/current/);
        await expect(root.locator("[data-graph-fit]")).toBeEnabled();
      }
    } finally {
      await stopFixtureServer(server);
    }
  });
}

test("snapshot eligibility is distinct from outgoing topology and broad next emphasis", async ({ page }) => {
  const snapshot = makeInspectionSnapshot({
    lifecycleAllowedTransitions: ["draft_gate", "not_a_state"],
  });
  snapshot.layers.copilot.allowedTransitions = ["done"];
  const { server, url } = await startViewer(snapshot);
  try {
    await page.goto(url);
    await openTab(page, "graph");
    const graph = await waitForInspectionGraph(page);
    const root = page.locator("[data-inspection-graph-root]");
    await expect(graph.locator(".inspection-graph-node.next")).toHaveCount(1);
    await expect(graph.locator('[data-state-id="draft_gate"]')).toHaveClass(/next/);
    const details = root.locator("[data-graph-node-details]");
    await expect(details).toContainText("feedback_resolution");
    await expect(details).toContainText("not_a_state");
    await root.locator('[data-graph-layer="copilot_layer"]').click();
    const done = graph.locator('[data-state-id="done"]');
    await done.focus();
    await done.press("Enter");
    await expect(done).not.toHaveClass(/\bnext\b/);
    const membership = details.locator("dt").filter({ hasText: "Snapshot eligibility for this state" }).locator("+ dd");
    await expect(membership).toHaveText(/^Included in snapshot allowed transitions$/);
    await root.locator('[data-graph-layer="outer_loop_family"]').click();
    await expect(graph.locator(".inspection-graph-node.next")).toHaveCount(0);
    await expect(details).toContainText(/Broad next set/);
    await root.locator('[data-graph-layer="reviewer_layer"]').click();
    await graph.locator('[data-state-id="waiting_for_author_followup"]').focus();
    await graph.locator('[data-state-id="waiting_for_author_followup"]').press("Enter");
    await expect(details).toContainText(/Authoritative outgoing transitions/);
    await expect(details).toContainText("waiting_for_author_followup");
  } finally {
    await stopFixtureServer(server);
  }
});

test("missing transitions are unavailable rather than an explicitly empty list", async ({ page }) => {
  const { server, url } = await startViewer(makeInspectionSnapshot({ lifecycleAllowedTransitions: undefined }));
  try {
    await page.goto(url);
    await openTab(page, "graph");
    const graph = await waitForInspectionGraph(page);
    await expect(graph.locator(".inspection-graph-node.next")).toHaveCount(0);
    await expect(page.locator("[data-graph-node-details]")).toContainText(/Snapshot transition availability.*unavailable/s);
    await expect(page.locator("[data-graph-node-details]")).not.toContainText(/Explicitly empty/);
  } finally {
    await stopFixtureServer(server);
  }
});

test("existing shell auto-reload remains opt-in, persisted and independently stoppable", async ({ page }) => {
  const { server, url } = await startViewer();
  try {
    await page.goto(url);
    const period = page.getByRole("combobox", { name: "Auto-reload period" });
    const manual = page.getByRole("button", { name: "Reload snapshot" });
    await expect(period).toHaveValue("off");
    await expect(manual).toBeVisible();
    await period.selectOption({ label: "1 minute" });
    await expect(manual).toBeHidden();
    await page.reload();
    await expect(period).toHaveValue("60000");
    await period.selectOption({ label: "Off" });
    await expect(manual).toBeVisible();
    await page.reload();
    await expect(period).toHaveValue("off");
    await openTab(page, "graph");
    await waitForInspectionGraph(page);
    await expect(manual).toBeVisible();
  } finally {
    await stopFixtureServer(server);
  }
});

test("webkit renders the Agent handoff tab and validates structured envelope rendering", async ({ page }, testInfo) => {
  const { server, url } = await startViewer(makeInspectionSnapshot());

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // Tab navigation is visible
    const handoffTab = page.locator('.viewer-tab[data-tab="handoff"]');
    await expect(handoffTab).toBeVisible();
    await expect(handoffTab).toHaveText("Agent handoff");

    // Overview tab is visible and active by default
    const graphTab = page.locator('.viewer-tab[data-tab="graph"]');
    const overviewTab = page.locator('.viewer-tab[data-tab="overview"]');
    const layersTab = page.locator('.viewer-tab[data-tab="layers"]');
    await expect(graphTab).toBeVisible();
    await expect(overviewTab).toBeVisible();
    await expect(layersTab).toBeVisible();
    await expect(overviewTab).toHaveClass(/active/);
    await expect(graphTab).not.toHaveClass(/active/);

    // Handoff tab content is present (may show "Envelope unavailable" if resolver unavailable)
    await openTab(page, 'handoff');
    await expect(handoffTab).toHaveClass(/active/);
    await expect(overviewTab).not.toHaveClass(/active/);

    // Handoff content section is visible
    const handoffSection = page.locator("#handoff-envelope-section");
    await expect(handoffSection).toBeVisible();

    // Verify envelope content renders with key fields
    await expect(handoffSection).toContainText(/Agent handoff/);
    await expect(handoffSection).not.toContainText(/Envelope unavailable/);
    await expect(handoffSection).toContainText(/Target/);
    await expect(handoffSection).toContainText(/Current state/);
    await expect(page.locator('#handoff-envelope-section .handoff-card')).toHaveCount(9);
    await expect(page.locator('#handoff-envelope-section [data-field="currentGate"] dd')).toHaveText(/draft/i);
    await expect(handoffSection).toContainText(/Policy/);
    await expect(handoffSection).toContainText(/Acceptance/);

    // Switch back to graph view
    await openTab(page, 'graph');
    await expect(graphTab).toHaveClass(/active/);
  } finally {
    await stopFixtureServer(server);
  }
});

test("webkit renders envelope unavailable fallback when loadHandoffEnvelope returns null", async ({ page }) => {
  const { server, url } = await startFixtureServer(() => createInspectRunViewerServer(
    { repo: "owner/repo", pr: "55", host: "127.0.0.1", port: 0 },
    {
      adapter: {
        async loadSnapshot() {
          return makeInspectionSnapshot();
        },
        async loadHandoffEnvelope() {
          return null; // null return triggers unavailable fallback
        },
        async listAssignedPullRequests() {
          return [{ target: { repo: "owner/repo", pr: 55 }, title: "Current PR" }];
        },
      },
    },
  ));

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const handoffTab = page.locator('.viewer-tab[data-tab="handoff"]');
    await handoffTab.click();

    const handoffSection = page.locator("#handoff-envelope-section");
    await expect(handoffSection).toBeVisible();
    await expect(handoffSection).toContainText(/Envelope unavailable/);
    await expect(handoffSection).toContainText(/buildDevLoopHandoffEnvelope/);
  } finally {
    await stopFixtureServer(server);
  }
});
