// Worker hard limits (#3654): fixer and developer agents carry the same `## Hard limits` section.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel) => readFile(`${repoRoot}${rel}`, "utf8");

function hardLimits(text) {
  const match = text.match(/^## Hard limits\n([\s\S]*?)(?=^## |$(?![\s\S]))/m);
  assert.ok(match, "missing ## Hard limits section");
  return match[1];
}

for (const file of ["agents/fixer.agent.md", "agents/developer.agent.md"]) {
  test(`${file} has a Hard limits section with the worker limits`, async () => {
    const section = hardLimits(await read(file));
    assert.match(section, /Edit or Write tools/);
    assert.match(section, /sed -i/);
    assert.match(section, /shell redirection/);
    assert.match(section, /any other script that rewrites files/);
    assert.match(section, /--allow-untick/);
    assert.match(section, /--allow-cross-issue/);
    assert.match(section, /merge script/);
    assert.match(section, /approve-merge/);
  });
}

test("agents/fixer.agent.md states the stale-prose search rule", async () => {
  const text = (await read("agents/fixer.agent.md")).replace(/\s+/g, " ");
  assert.match(text, /stale or contradicting prose/);
  for (const root of ["`skills/`", "`agents/`", "`docs/`", "`docs/decisions/`", "`scripts/`", "`packages/core/src/`", "`test/`"]) {
    assert.ok(text.includes(root), `missing search root ${root}`);
  }
  assert.match(text, /Fix every in-scope hit in the same pass/);
  assert.match(text, /out of scope with the reason/);
});
