import { fileURLToPath } from "node:url";

import { articleRegistryEntry, defineArticleSuite } from "./harness/deck-fit-harness.mjs";

const entry = articleRegistryEntry("how-decided-article");

defineArticleSuite({
  ...entry,
  articlePath: fileURLToPath(new URL(`../../docs/articles/${entry.file}`, import.meta.url)),
});
