import { defineConfig } from "@playwright/test";

import { createWebkitSmokeConfig } from "./test/playwright/harness/webkit-smoke-harness.mjs";

export default defineConfig(createWebkitSmokeConfig({
  sliceId: "deep-dive-article",
  testMatch: ["deep-dive-article.spec.mjs"],
}));
