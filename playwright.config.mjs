import { defineConfig } from "@playwright/test";

import { ARTICLE_REGISTRY, DECK_REGISTRY } from "./test/playwright/harness/deck-fit-harness.mjs";
import { VIEWER_REGISTRY } from "./test/playwright/harness/inspect-run-viewer-harness.mjs";
import { normalizeUiStateSegment } from "./test/playwright/harness/webkit-smoke-harness.mjs";

// One project per slice, generated from the registries so adding a slice needs
// only a registry entry — no config edit. Each project pins its single spec and
// a distinct outputDir for per-slice artifact separation.
const sliceIds = [
  ...Object.values(DECK_REGISTRY).map((entry) => entry.sliceId),
  ...Object.values(ARTICLE_REGISTRY).map((entry) => entry.sliceId),
  VIEWER_REGISTRY.sliceId,
];

// Note: the outputDir/name/testMatch below embed the raw sliceId, but the smoke
// harness records artifacts under normalizeUiStateSegment(sliceId). Fail fast if
// a registry sliceId is not already its normalized form, so the on-disk
// test-results/ui-smoke/<sliceId> path stays == the normalized artifact segment.
for (const sliceId of sliceIds) {
  const normalized = normalizeUiStateSegment(sliceId);
  if (sliceId !== normalized) {
    throw new Error(
      `Registry sliceId "${sliceId}" is not normalized (expected "${normalized}"); sliceIds must equal their normalized form so test-results/ui-smoke/<sliceId> matches the artifact path segment.`,
    );
  }
}

export default defineConfig({
  testDir: "./test/playwright",
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  // Note: the html reporter's outputFolder is global, not per-project, but each
  // smoke npm script runs exactly one project and sets PW_UI_SLICE, so each
  // slice's HTML report keeps its playwright-report/ui-smoke/<sliceId>/ contract path.
  reporter: [["list"], ["html", { open: "never", outputFolder: `playwright-report/ui-smoke/${process.env.PW_UI_SLICE ?? "all"}` }]],
  use: {
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: sliceIds.map((sliceId) => ({
    name: sliceId,
    testMatch: [`${sliceId}.spec.mjs`],
    outputDir: `test-results/ui-smoke/${sliceId}`,
    use: { browserName: "webkit" },
  })),
});
