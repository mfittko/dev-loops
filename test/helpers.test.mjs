import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { makeJsonGhStub, runNode, withTempDir } from "./_helpers.mjs";

test("makeJsonGhStub: success serializes the payload; failure emits empty stdout + stderr; the entry repeats", async () => {
  const ok = makeJsonGhStub({ number: 7, state: "OPEN" });
  const first = await ok.run("gh", ["issue", "view", "7"]);
  assert.equal(first.code, 0);
  assert.deepEqual(JSON.parse(first.stdout), { number: 7, state: "OPEN" });
  // repeatLastOnOverflow: a second call still resolves from the single entry.
  const second = await ok.run("gh", ["issue", "view", "7", "--json", "state"]);
  assert.equal(JSON.parse(second.stdout).number, 7);
  assert.equal(ok.calls.length, 2);

  const failed = await makeJsonGhStub(null, { code: 1, stderr: "no such issue" }).run("gh", ["issue", "view", "9"]);
  assert.equal(failed.code, 1);
  assert.equal(failed.stdout, "");
  assert.equal(failed.stderr, "no such issue");
});

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
