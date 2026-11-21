// Issue 3251: a hung WebKit smoke job must fail fast instead of waiting the 360-minute GitHub default.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "bun:test";

const ci = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

for (const job of ["viewer-smoke", "deck-smoke", "article-smoke"]) {
  test(`${job} sets timeout-minutes on the job, the WebKit setup step and the run step`, () => {
    const block = ci.split(new RegExp(`^  ${job}:\\n`, "m"))[1].split(/^  \S/m)[0];
    assert.match(block, /^    timeout-minutes: \d+$/m, "job-level timeout-minutes");
    const steps = block.split(/^      - name: /m).slice(1).filter((s) => !s.startsWith("Check out"));
    assert.equal(steps.length, 2, "WebKit setup step and run step");
    for (const step of steps) assert.match(step, /^        timeout-minutes: \d+$/m, `step timeout-minutes: ${step.split("\n")[0]}`);
  });
}
