import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "bun:test";
import { VERIFY_SUITES, createAttributedWriter, runSuite, runVerification } from "../../scripts/verify.mjs";

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
  const encoded = Buffer.from("fatal: → details\nnext");
  for (const chunk of [encoded.subarray(0, 8), encoded.subarray(8, 9), encoded.subarray(9)]) writer.write(chunk);
  writer.end();
  assert.equal(output, "[test:all] fatal: → details\n[test:all] next\n");
});

test("suite spawn failure resolves without piped streams or a close event", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null });
  let errors = "";
  const result = runSuite("test:all", {
    spawnImpl: () => child,
    stderr: { write: (chunk) => { errors += chunk; } },
  });
  queueMicrotask(() => child.emit("error", new Error("spawn denied")));
  assert.equal(await result, 1);
  assert.match(errors, /spawn denied/);
});
