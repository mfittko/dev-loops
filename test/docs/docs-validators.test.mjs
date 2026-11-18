import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

import { runDocsValidators } from "../../scripts/docs/docs-validators.mjs";

test("runDocsValidators maps a throwing validator to crashed: true with a nonzero code", async () => {
  const [result] = await runDocsValidators({ root: "/nonexistent/docs-validators-root", ids: ["rule-ownership"] });
  assert.equal(result.crashed, true);
  assert.notEqual(result.code, 0);
});

test("the rule-ownership entry prints the standalone CLI report, including the runtime-enforcement line", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const [result] = await runDocsValidators({ root, ids: ["rule-ownership"] });
  assert.equal(result.crashed, false);
  assert.match(result.output, /^Rule ownership validation (passed: \d+ rules, \d+ references, \d+ terms, \d+ files scanned\. Runtime rules: \d+ total, \d+ enforced, \d+ unenforced\.|failed:\n)/);
});
