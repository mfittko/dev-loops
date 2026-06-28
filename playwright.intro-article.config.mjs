import { defineConfig } from "@playwright/test";

import { createWebkitSmokeConfig } from "./test/playwright/harness/webkit-smoke-harness.mjs";

export default defineConfig(createWebkitSmokeConfig({
  sliceId: "intro-article",
  testMatch: ["intro-article.spec.mjs"],
}));
