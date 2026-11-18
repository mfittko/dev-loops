import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { SPEC_AUTHORITY_VERDICT_SCHEMA } from "../../packages/core/src/loop/spec-authority.mjs";
import { main } from "../../scripts/loop/check-judge-decision.mjs";

async function check(argv) {
  let out = "";
  const previous = process.exitCode;
  await main(argv, { stdout: { write: (text) => { out += text; } }, stderr: { write: (text) => { out += text; } } });
  const exitCode = process.exitCode;
  process.exitCode = previous;
  return { exitCode, out };
}

test("issue 3093 AC2: no --file prints usage naming spec-authority-verdict.json", async () => {
  const { exitCode, out } = await check([]);
  assert.equal(exitCode, 1);
  assert.match(out, /Usage: check-judge-decision\.mjs --file <spec-authority-verdict\.json>/);
});

test("issue 3093 AC2: a missing path and a judge-verdict.json name the expected file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "check-judge-decision-"));
  try {
    const missing = await check(["--file", path.join(dir, "none.json"), "--silent"]);
    assert.equal(missing.exitCode, 1);
    const relevance = path.join(dir, "judge-verdict.json");
    await writeFile(relevance, JSON.stringify({ dispositions: [] }));
    for (const file of [path.join(dir, "none.json"), relevance]) {
      const { exitCode, out } = await check(["--file", file]);
      assert.equal(exitCode, 1);
      assert.match(JSON.parse(out).error, /validates the spec-authority-verdict\.json outputRef, not judge-verdict\.json; usage: check-judge-decision\.mjs --file <spec-authority-verdict\.json>/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue 3093 AC3: both schema examples pass the checker", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "check-judge-decision-"));
  try {
    for (const [i, example] of SPEC_AUTHORITY_VERDICT_SCHEMA.examples.entries()) {
      const file = path.join(dir, `example-${i}.json`);
      await writeFile(file, JSON.stringify(example));
      const { exitCode, out } = await check(["--file", file]);
      assert.deepEqual(JSON.parse(out), { ok: true, checked: 1 });
      assert.equal(exitCode, 0);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
