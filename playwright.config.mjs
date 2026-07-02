import { defineConfig } from "@playwright/test";

import { ARTICLE_REGISTRY, DECK_REGISTRY } from "./test/playwright/harness/deck-fit-harness.mjs";
import { VIEWER_REGISTRY } from "./test/playwright/harness/inspect-run-viewer-harness.mjs";

// One project per slice, generated from the registries so adding a slice needs
// only a registry entry — no config edit. Each project pins its single spec and
// a distinct outputDir for per-slice artifact separation.
const sliceIds = [
  ...Object.values(DECK_REGISTRY).map((entry) => entry.sliceId),
  ...Object.values(ARTICLE_REGISTRY).map((entry) => entry.sliceId),
  VIEWER_REGISTRY.sliceId,
];

export default defineConfig({
  testDir: "./test/playwright",
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  // ponytail: html outputFolder can't be per-project; per-project outputDir gives per-slice artifacts.
  reporter: [["list"], ["html", { open: "never" }]],
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
