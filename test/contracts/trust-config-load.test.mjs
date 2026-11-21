import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadDevLoopConfig } from "../../packages/core/src/config/config.mjs";

async function errorsFor(trustYaml) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-trust-cfg-"));
  try {
    await writeFile(path.join(repoRoot, ".devloops"), `version: 1\ntrust:\n${trustYaml}\n`);
    return (await loadDevLoopConfig({ repoRoot })).errors;
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

test("a valid trust block loads with no error", async () => {
  assert.deepEqual(await errorsFor("  githubActionsBot: false\n  reviewers:\n    - reviewdog[bot]\n    - external-reviewer"), []);
});

for (const [label, yaml] of [
  ["a non-boolean githubActionsBot", "  githubActionsBot: 'no'"],
  ["a reviewer with a space", "  reviewers:\n    - 'bad login'"],
  ["a reviewer with a slash", "  reviewers:\n    - org/team"],
  ["an over-long login", `  reviewers:\n    - ${"a".repeat(40)}`],
  ["an unknown key", "  wildcard: true"],
]) {
  test(`${label} is a config load error`, async () => {
    assert.ok((await errorsFor(yaml)).length > 0);
  });
}
