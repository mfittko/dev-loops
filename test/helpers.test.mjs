import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { runNode, withTempDir } from "./_helpers.mjs";

test("runNode preserves child termination signals in its result and stderr", async () => {
  await withTempDir(async (directory) => {
    const script = path.join(directory, "terminate.mjs");
    await writeFile(script, [
      "process.stderr.write('context without newline');",
      "process.kill(process.pid, 'SIGTERM');",
      "setInterval(() => {}, 1_000);",
    ].join("\n"));

    const result = await runNode(script);
    assert.equal(result.code, null);
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.stderr, "context without newline\nrunNode: child terminated by signal SIGTERM\n");
  }, { prefix: "run-node-signal-" });
});
