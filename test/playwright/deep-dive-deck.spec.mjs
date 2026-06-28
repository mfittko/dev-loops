import { fileURLToPath } from "node:url";

import { deckRegistryEntry, defineDeckSuite } from "./harness/deck-fit-harness.mjs";

const entry = deckRegistryEntry("deep-dive-deck");

defineDeckSuite({
  ...entry,
  deckPath: fileURLToPath(new URL(`../../docs/presentations/${entry.deck}`, import.meta.url)),
});
