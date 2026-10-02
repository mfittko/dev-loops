import { fileURLToPath } from "node:url";

import { articleRegistryEntry } from "./harness/deck-fit-harness.mjs";
import { defineSimulatorSuite } from "./harness/simulator-harness.mjs";

const entry = articleRegistryEntry("simulator-overview-article");

defineSimulatorSuite({
  ...entry,
  articlePath: fileURLToPath(new URL(`../../docs/articles/${entry.file}`, import.meta.url)),
  heading: "One issue, from startup to merge",
  currentView: "Overview: the lifecycle",
  linkedView: "Detailed: every sub-loop",
  linkedFile: "simulator.html",
  firstStep: "loop startup",
  firstTrace: "startup:",
});
