import { expect } from "@playwright/test";

import { createInspectRunViewerServer } from "../../../scripts/loop/inspect-run-viewer.mjs";
import { captureNamedUiState, startFixtureServer } from "./webkit-smoke-harness.mjs";
import { makeInspectionSnapshot } from "../fixtures/inspect-run-viewer-fixture.mjs";

// The inspect-run viewer is an interactive dashboard (not a fit-checked deck),
// so it registers its own server factory + structural ids + capture helper here.
// Its unique interactive assertions live in the spec; the shared structural
// guard (assertSectionIdsAndNoHorizontalScroll) and capture come from the
// harness so nothing is copy-pasted across the viewer's many test bodies.

export { makeInspectionSnapshot };

export async function startViewer(snapshot = makeInspectionSnapshot(), assignedPullRequests = []) {
  const normalizedAssignedPullRequests = assignedPullRequests.some((entry) => entry?.target?.repo === "owner/repo" && entry?.target?.pr === 55)
    ? assignedPullRequests
    : [{ target: { repo: "owner/repo", pr: 55 }, title: "Current PR" }, ...assignedPullRequests];

  return startFixtureServer(() => createInspectRunViewerServer(
    { repo: "owner/repo", pr: "55", host: "127.0.0.1", port: 0 },
    {
      adapter: {
        async loadSnapshot() {
          return snapshot;
        },
        async loadHandoffEnvelope() {
          return {
            handoffVersion: 1,
            derivedAt: new Date().toISOString(),
            target: { kind: "pr", repo: "owner/repo", pr: 55 },
            currentGate: "draft",
            currentHeadSha: "abc1234",
            ciStatus: "success",
            unresolvedThreadCount: 0,
            copilotRoundCount: 0,
            maxCopilotRounds: 5,
            executionMode: "bounded_handoff",
            nextAction: "Run draft gate review",
            requiredReads: ["skills/docs/gate-review-comment-contract.md"],
            gateConfig: { angles: ["scope", "coverage"], blockCleanOnFindingSeverities: ["must-fix"], requireCi: true },
            stopRules: ["draft-pr", "merge"],
            asyncStartMode: "required",
            requireDraftFirst: true,
            cwd: "/tmp/worktrees/pr-55",
            worktreeRequired: true,
            acceptance: { criteria: [{ id: "ac", must: "Test", severity: "required" }], evidence: ["commands-run"], maxFinalizationTurns: 4 },
            control: { needsAttentionAfterMs: 300000, activeNoticeAfterMs: 300000 },
          };
        },
        async listAssignedPullRequests() {
          return normalizedAssignedPullRequests;
        },
      },
    },
  ));
}

export async function openTab(page, tabName) {
  await page.locator(`.viewer-tab[data-tab="${tabName}"]`).click();
}

export async function waitForMermaidGraph(page) {
  const graphPanel = page.locator("#tab-graph");
  await expect(graphPanel).toHaveClass(/active/);
  const graph = graphPanel.locator(".mermaid-state-graph");
  await expect(graph).toHaveAttribute("data-rendered", "true");
  await expect(graph.locator("svg")).toBeVisible();
  return graph;
}

// One capture helper so the viewer's repeated capture block isn't copy-pasted
// across its tests — the registry's sliceId and a per-state name/hint feed it.
export function captureViewerState(page, testInfo, stateName, reviewHint) {
  return captureNamedUiState({
    page,
    testInfo,
    sliceId: VIEWER_REGISTRY.sliceId,
    stateName,
    metadata: { fixture: "makeInspectionSnapshot", route: "/", reviewHint },
  });
}

export const VIEWER_REGISTRY = {
  sliceId: "inspect-run-viewer",
  // Stable structural ids the dashboard guarantees — the shared section-id
  // presence guard asserts these without duplicating the deck-fit machinery.
  sectionIds: ["tab-overview", "tab-graph", "tab-layers", "tab-handoff"],
};
