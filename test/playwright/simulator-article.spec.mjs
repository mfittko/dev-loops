import { fileURLToPath } from "node:url";

import { articleRegistryEntry } from "./harness/deck-fit-harness.mjs";
import { defineSimulatorSuite } from "./harness/simulator-harness.mjs";

const entry = articleRegistryEntry("simulator-article");

defineSimulatorSuite({
  ...entry,
  articlePath: fileURLToPath(new URL(`../../docs/articles/${entry.file}`, import.meta.url)),
  heading: "One unit of work, from startup to merge",
  currentView: "Detailed: every sub-loop",
  linkedView: "Overview: the lifecycle",
  linkedFile: "simulator-overview.html",
  firstStep: "operator request",
  firstTrace: "request:",
});
