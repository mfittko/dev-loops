import { fileURLToPath } from "node:url";

import { DECK_REGISTRY, defineDeckSuite } from "./harness/deck-fit-harness.mjs";

const entry = DECK_REGISTRY["deep-dive-deck"];

defineDeckSuite({
  ...entry,
  deckPath: fileURLToPath(new URL(`../../docs/presentations/${entry.deck}`, import.meta.url)),
});
