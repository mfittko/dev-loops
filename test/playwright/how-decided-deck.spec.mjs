import { fileURLToPath } from "node:url";

import { deckRegistryEntry, defineDeckSuite } from "./harness/deck-fit-harness.mjs";

const entry = deckRegistryEntry("how-decided-deck");

defineDeckSuite({
  ...entry,
  deckPath: fileURLToPath(new URL(`../../docs/presentations/${entry.deck}`, import.meta.url)),
});
