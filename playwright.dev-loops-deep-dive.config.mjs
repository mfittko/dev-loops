import { defineConfig } from "@playwright/test";

import { createWebkitSmokeConfig } from "./test/playwright/harness/webkit-smoke-harness.mjs";

export default defineConfig(createWebkitSmokeConfig({
  sliceId: "deep-dive-deck",
  testMatch: ["deep-dive-deck.spec.mjs"],
}));
