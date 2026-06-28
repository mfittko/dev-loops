import { test, expect } from "@playwright/test";

import { createInspectRunViewerServer } from "../../scripts/loop/inspect-run-viewer.mjs";
import { startFixtureServer, stopFixtureServer } from "./harness/webkit-smoke-harness.mjs";
import { assertSectionIdsAndNoHorizontalScroll } from "./harness/deck-fit-harness.mjs";
import {
  VIEWER_REGISTRY,
  captureViewerState,
  makeInspectionSnapshot,
  openTab,
  startViewer,
  waitForMermaidGraph,
} from "./harness/inspect-run-viewer-harness.mjs";

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
    await expect(page.locator(".state-graph-intro")).toHaveCount(0);
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

    await openTab(page, 'graph');
    const graphGuide = page.getByText(/Graph guide and lane details/);
    await expect(graphGuide).toBeVisible();
    await graphGuide.click();
    const graphBox = page.locator("#tab-graph .viewer-graph-body");
    await expect(graphBox.getByRole("button", { name: "Zoom in" })).toBeVisible();
    await expect(graphBox.getByRole("button", { name: "Zoom out" })).toBeVisible();
    await expect(graphBox.getByRole("button", { name: "Reset zoom" })).toBeVisible();
    await expect(graphBox.getByRole("button", { name: "Open graph fullscreen" })).toBeVisible();
    const graph = await waitForMermaidGraph(page);
    await expect(graphBox.locator('[data-graph-zoom-value]')).toHaveText('300%');
    await expect(graph).toHaveCSS("cursor", "grab");
    await expect(graph).toContainText(/Start/);
    await expect(graph).toContainText(/continue current wait/);
    await expect(graph).toContainText(/waiting_for_copilot_review/);
    await expect(graph).toContainText(/review_requested/);
    await expect(page.getByText(/outer-loop family:\s*current\s*continue_current_wait; continue_current_wait; full authoritative state machine shown; continue_current_wait, handoff_to_copilot_loop, handoff_to_reviewer_loop, stay_with_current_live_owner, stop_needs_human, done_terminal, needs_reconcile/i)).toBeVisible();
    await expect(page.getByText(/copilot layer:\s*current\s*waiting_for_copilot_review; waiting_for_copilot_review; full authoritative state machine shown; unresolved_feedback_present, ready_to_rerequest_review, waiting_for_ci/i)).toBeVisible();
    const lifecycleLaneRender = await graph.evaluate((node) => {
      const svg = node.querySelector('svg');
      const laneTitles = [...svg.querySelectorAll('g.cluster text')]
        .map((entry) => ({ text: entry.textContent?.trim() ?? '', y: entry.getBoundingClientRect().y }))
        .filter((entry) => entry.text.length > 0)
        .sort((a, b) => a.y - b.y)
        .map((entry) => entry.text);
      const currentLifecycle = svg.querySelector('g.node.current[id*="flowchart-lifecycle_layer_implementation"]');
      const nextLifecycleNodes = [...svg.querySelectorAll('g.node.next[id*="flowchart-lifecycle_layer_"]')]
        .map((entry) => entry.textContent?.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .sort();
      return {
        laneTitles,
        currentLifecycleClass: currentLifecycle?.getAttribute('class') ?? null,
        nextLifecycleNodes,
      };
    });
    expect(lifecycleLaneRender.laneTitles).toEqual([
      'outer-loop family',
      'copilot layer',
      'reviewer layer',
      'lifecycle',
    ]);
    expect(lifecycleLaneRender.currentLifecycleClass).toContain('current');
    expect(lifecycleLaneRender.nextLifecycleNodes).toEqual(['draft gate', 'feedback resolution']);

    await graphBox.getByRole("button", { name: "Zoom in" }).click();
    await graphBox.getByRole("button", { name: "Zoom in" }).click();
    const scroller = page.locator(".mermaid-state-graph");
    const scrollRoom = await scroller.evaluate((node) => ({
      maxLeft: Math.max(0, node.scrollWidth - node.clientWidth),
      maxTop: Math.max(0, node.scrollHeight - node.clientHeight),
    }));
    expect(scrollRoom.maxLeft > 0 || scrollRoom.maxTop > 0).toBeTruthy();
    await scroller.evaluate((node) => {
      node.scrollLeft = 0;
      node.scrollTop = 0;
    });
    const beforeScroll = await scroller.evaluate((node) => ({ left: node.scrollLeft, top: node.scrollTop }));
    // Dispatch pointer events directly to bypass Playwright mouse routing
    // issues with the nested zoom wrapper in WebKit.
    await scroller.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const startX = rect.left + rect.width * 0.7;
      const startY = rect.top + rect.height * 0.5;
      const endX = rect.left + rect.width * 0.3;
      const endY = rect.top + rect.height * 0.5;
      node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: startX, clientY: startY }));
      node.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: endX, clientY: endY }));
      node.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: endX, clientY: endY }));
    });
    const afterScroll = await scroller.evaluate((node) => ({ left: node.scrollLeft, top: node.scrollTop }));
    expect(afterScroll.left !== beforeScroll.left || afterScroll.top !== beforeScroll.top).toBeTruthy();

    await graphBox.getByRole("button", { name: "Reset zoom" }).click();
    await expect(graphBox.locator("[data-graph-zoom-value]")).toHaveText("100%");
    await scroller.evaluate((node) => {
      node.scrollLeft = 0;
      node.scrollTop = 0;
    });
    await scroller.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const clientX = rect.left + (rect.width * 0.8);
      const clientY = rect.top + (rect.height * 0.75);
      node.dispatchEvent(new MouseEvent("dblclick", {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
      }));
    });
    await expect(graphBox.locator("[data-graph-zoom-value]")).toHaveText("125%");

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

test("webkit shows checkpoint-only graph uncertainty without guessing missing transitions", async ({ page }, testInfo) => {
  const { server, url } = await startViewer(makeInspectionSnapshot({
    sourceMode: "checkpoint-only",
    trust: "checkpoint",
    needsAttention: true,
    statusClass: "unknown",
    outerState: "unknown",
    allowedTransitions: undefined,
    outerAction: "unknown",
    layers: {
      steering: { status: "unavailable", reason: "no_steering_file" },
    },
  }));

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Current PR" })).toBeVisible();
    await expect(page.locator(".current-pr-state-summary-headline")).toContainText(/Needs attention/);
    await expect(page.locator(".state-graph-intro")).toHaveCount(0);
    await openTab(page, 'graph');
    await page.getByText(/Graph guide and lane details/).click();
    const graph = await waitForMermaidGraph(page);
    await expect(graph).toContainText(/current state unavailable/);
    await expect(page.getByText(/copilot layer:\s*current\s*current state unavailable; current state unavailable; full authoritative state machine shown; transition data unavailable in this snapshot/i)).toBeVisible();
    await expect(page.getByText(/reviewer layer:\s*current\s*current state unavailable; current state unavailable; full authoritative state machine shown; transition data unavailable in this snapshot/i)).toBeVisible();

    await captureViewerState(page, testInfo, "Checkpoint only graph uncertainty", "Confirms the harness can capture an uncertainty state without inferred transitions.");
  } finally {
    await stopFixtureServer(server);
  }
});

test("webkit shows degraded graph messaging when snapshot trust is partial", async ({ page }, testInfo) => {
  const { server, url } = await startViewer(makeInspectionSnapshot({
    sourceMode: "partial",
    trust: "degraded",
  }));

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });

    await expect(page.locator(".state-graph-intro")).toHaveCount(0);
    await openTab(page, 'graph');
    await waitForMermaidGraph(page);

    await captureViewerState(page, testInfo, "Degraded graph messaging", "Demonstrates the partial-trust path for reusable smoke coverage.");
  } finally {
    await stopFixtureServer(server);
  }
});

test("webkit shows terminal merged states clearly in the Mermaid graph", async ({ page }, testInfo) => {
  const { server, url } = await startViewer(makeInspectionSnapshot({
    outerState: "done_terminal",
    activeFamilyState: "done",
    outerAction: "done",
    statusClass: "done",
    layers: {
      copilot: {
        currentState: "done",
        allowedTransitions: [],
      },
      reviewer: {
        currentState: "waiting_for_review_request",
        scope: { mode: "all_reviewers", reviewerLogin: null },
        allowedTransitions: [],
      },
      steering: { status: "unavailable", reason: "no_steering_locator" },
    },
  }));

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const currentStateBanner = page.locator('section[aria-label="PR #55"]');
    await expect(currentStateBanner.getByRole("heading", { name: "Current PR" })).toBeVisible();
    await expect(currentStateBanner.getByText("PR complete")).toBeVisible();
    await openTab(page, 'overview');
    await expect(page.locator('#tab-overview')).toContainText(/status class/);
    await expect(page.locator('#tab-overview')).toContainText(/done/);
    await openTab(page, 'graph');
    await page.getByText(/Graph guide and lane details/).click();
    const graph = await waitForMermaidGraph(page);
    await expect(graph).toContainText(/End/);
    await expect(graph).toContainText(/done/);
    await expect(page.getByText(/copilot layer:\s*current\s*done; done; full authoritative state machine shown; no allowed transitions/i)).toBeVisible();

    await captureViewerState(page, testInfo, "Terminal merged state", "Confirms the terminal merged state remains reviewable in WebKit.");
  } finally {
    await stopFixtureServer(server);
  }
});

test("webkit shows the unavailable-state fallback for unavailable snapshots", async ({ page }, testInfo) => {
  const { server, url } = await startViewer(makeInspectionSnapshot({
    sourceMode: "unavailable",
    trust: "unknown",
    activeFamilyState: "unknown",
    layers: {
      steering: { status: "unavailable", reason: "no_steering_locator" },
    },
  }));

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });

    await openTab(page, 'graph');
    await expect(page.locator(".mermaid-state-graph")).toHaveCount(0);
    await expect(page.locator('#tab-graph')).toContainText(/Snapshot unavailable, so no state graph can be rendered yet/i);

    await captureViewerState(page, testInfo, "Unavailable snapshot fallback", "Captures the no-graph fallback for unavailable snapshots.");
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
