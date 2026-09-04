import assert from "node:assert/strict";
import { test } from "bun:test";
import { analyzeBenchmark } from "../../scripts/benchmarks/analyze-package-manager.mjs";

const run = (tool, session, measured, durationMs, exitCode = 0) => ({ tool, session, measured, durationMs, exitCode });

function evidence(overrides = {}) {
  return {
    protocolVersion: 1,
    environment: { platform: "linux", arch: "x64", cpu: "fixture", node: "v24", bun: "1.4.1", npm: "11" },
    inventory: { npm: { files: 3, bytes: 30 }, bun: { files: 3, bytes: 30 } },
    installs: {
      npm: { cold: run("npm", "install", true, 100), warm: run("npm", "install", true, 80) },
      bun: { cold: run("bun", "install", true, 50), warm: run("bun", "install", true, 40) },
    },
    verify: [1, 2].flatMap((session) => {
      const pair = (npmRun, bunRun) => session === 1 ? [npmRun, bunRun] : [bunRun, npmRun];
      return [
        ...pair(run("npm", session, false, 99), run("bun", session, false, 98)),
        ...Array.from({ length: 7 }, (_, index) => pair(run("npm", session, true, 100 + index), run("bun", session, true, 70 + index))).flat(),
      ];
    }),
    ...overrides,
  };
}

test("benchmark analyzer enforces install ratios and both independent verify sessions", () => {
  const verdict = analyzeBenchmark(evidence());
  assert.equal(verdict.pass, true);
  assert.equal(verdict.installs.cold.ratio, 0.5);
  assert.equal(verdict.installs.warm.ratio, 0.5);
  assert.deepEqual(verdict.verify.map(({ wins, pass }) => ({ wins, pass })), [{ wins: 7, pass: true }, { wins: 7, pass: true }]);
});

test("benchmark analyzer fails closed on unequal inventory, failed commands, missing samples, or a weak session", () => {
  assert.equal(analyzeBenchmark(evidence({ inventory: { npm: { files: 2, bytes: 30 }, bun: { files: 3, bytes: 30 } } })).pass, false);
  const failed = evidence(); failed.verify[3].exitCode = 1;
  assert.equal(analyzeBenchmark(failed).pass, false);
  const missing = evidence(); missing.verify.pop();
  assert.equal(analyzeBenchmark(missing).pass, false);
  const weak = evidence();
  for (const sample of weak.verify.filter((item) => item.tool === "bun" && item.session === 2 && item.measured)) sample.durationMs = 200;
  assert.equal(analyzeBenchmark(weak).pass, false);
});
