import assert from "node:assert/strict";
import { test } from "bun:test";
import { VERIFY_SUITES, createAttributedWriter, runVerification } from "../../scripts/verify.mjs";

test("verification attempts every suite and aggregates failures", async () => {
  const attempted = [];
  const result = await runVerification({ execute: async (suite) => { attempted.push(suite); return suite === "test:docs" ? 7 : 0; } });
  assert.deepEqual(VERIFY_SUITES, ["test:all", "test:docs", "test:workflows"]);
  assert.deepEqual(attempted, VERIFY_SUITES);
  assert.equal(result.ok, false);
  assert.deepEqual(result.results.find(({ exitCode }) => exitCode), { suite: "test:docs", exitCode: 7 });
});

test("attributed output preserves lines split across stream chunks", () => {
  let output = "";
  const writer = createAttributedWriter({ write: (chunk) => { output += chunk; } }, "test:all");
  for (const chunk of ["fatal:", " details\nnext"]) writer.write(chunk);
  writer.end();
  assert.equal(output, "[test:all] fatal: details\n[test:all] next\n");
});
