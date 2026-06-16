import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const packageJsonUrl = new URL("../package.json", import.meta.url);

test("packages/core exports the sanctioned runtime boundary and de-exports unused weak-runtime surfaces", async () => {
  const packageJson = JSON.parse(await readFile(packageJsonUrl, "utf8"));

  assert.equal(packageJson.exports["./bash-exit-one"], "./src/bash-exit-one.mjs");
  assert.equal(packageJson.exports["./config"], "./src/config/config.mjs");
  assert.equal(packageJson.exports["./github/copilot-helpers"], "./src/github/copilot-helpers.mjs");
  assert.equal(packageJson.exports["./github/repo-slug"], "./src/github/repo-slug.mjs");
  assert.equal(packageJson.exports["./github/review-threads"], "./src/github/review-threads.mjs");
  assert.equal(packageJson.exports["./loop/async-start-contract"], "./src/loop/async-start-contract.mjs");
  assert.equal(packageJson.exports["./loop/conductor-routing"], "./src/loop/conductor-routing.mjs");
  assert.equal(packageJson.exports["./loop/copilot-ci-status"], "./src/loop/copilot-ci-status.mjs");
  assert.equal(packageJson.exports["./loop/copilot-loop-iterations"], "./src/loop/copilot-loop-iterations.mjs");
  assert.equal(packageJson.exports["./loop/copilot-loop-state"], "./src/loop/copilot-loop-state.mjs");
  assert.equal(packageJson.exports["./loop/outer-loop-state"], undefined);
  assert.equal(packageJson.exports["./loop/phase-files"], "./src/loop/phase-files.mjs");
  assert.equal(packageJson.exports["./loop/pr-gate-coordination"], "./src/loop/pr-gate-coordination.mjs");
  assert.equal(packageJson.exports["./loop/public-dev-loop-routing"], "./src/loop/public-dev-loop-routing.mjs");
  assert.equal(packageJson.exports["./loop/retrospective-checkpoint"], undefined);
  assert.equal(packageJson.exports["./loop/reviewer-loop-state"], "./src/loop/reviewer-loop-state.mjs");
  assert.equal(packageJson.exports["./loop/run-inspection"], "./src/loop/run-inspection.mjs");
  assert.equal(packageJson.exports["./loop/steering"], "./src/loop/steering.mjs");
  assert.equal(packageJson.exports["./loop/timeout-policy"], "./src/loop/timeout-policy.mjs");
  assert.equal(packageJson.exports["./loop/tracker-pr-state"], "./src/loop/tracker-pr-state.mjs");
  assert.equal(packageJson.exports["./analysis"], undefined);
  assert.equal(packageJson.exports["./cli/primitives"], "./src/cli/primitives.mjs");
  assert.equal(packageJson.exports["./cli/helpers"], "./src/cli/helpers.mjs");
  assert.equal(packageJson.exports["./harness"], "./src/harness/index.mjs");

  assert.equal(packageJson.exports["./loop/conductor-ownership"], undefined);
  assert.equal(packageJson.exports["./loop/conductor-pr-projection"], undefined);
});
