import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

import { evaluateShellSlugInjection } from "../../scripts/loop/check-shell-slug-injection.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Shell-slug-injection guard, repo-wide arm: the runtime source must never
// interpolate a remote-derived / repo-slug value into a shell-command string
// without a charset validator. Fails closed on a match, naming file:line + the
// safe alternative — this is the deterministic gate the soft review lens missed.
test("no runtime-source shell-string sink interpolates an unsanitized repo slug", () => {
  const out = evaluateShellSlugInjection({ repoRoot });
  assert.equal(out.outcome, "pass", `\n${out.reasons.join("\n")}`);
});
