import assert from "node:assert/strict";
import { test } from "bun:test";
import { analyzeBenchmark } from "../../scripts/benchmarks/analyze-package-manager.mjs";
import { buildPairOrders, MEASURED_REPETITIONS } from "../../scripts/benchmarks/run-package-manager.mjs";

const run = (tool, measured, durationMs, exitCode = 0) => ({ tool, measured, durationMs, exitCode });
const phase = (tool, duration) => ({ warmups: [run(tool, false, duration)], measured: Array.from({ length: 7 }, () => run(tool, true, duration)) });

function session(id, root, startTool) {
  const npmWarm = { prime: [run("npm", false, 80)], ...phase("npm", 80) };
  const bunWarm = { prime: [run("bun", false, 40)], ...phase("bun", 40) };
  const verify = [run("npm", false, 99), run("bun", false, 70)];
  for (const order of buildPairOrders(startTool)) for (const tool of order) verify.push(run(tool, true, tool === "npm" ? 100 : 70));
  return {
    protocolVersion: 2, sessionId: id, sessionRoot: root, startTool,
    environment: { platform: "linux", arch: "x64", cpu: "fixture", node: "v24", bun: "1.4.1", npm: "11", powerState: "AC power" },
    sourceFingerprint: { npm: "npm-sha", bun: "bun-sha" }, suiteInventory: { npm: ["a"], bun: ["a"] },
    inventory: { npm: { packages: ["a@1"], bins: ["a"], workspaceLinks: [] }, bun: { packages: ["a@1"], bins: ["a"], workspaceLinks: [] } },
    installs: { npm: { cold: phase("npm", 100), warm: npmWarm }, bun: { cold: phase("bun", 50), warm: bunWarm } }, verify,
  };
}

test("pair order alternates within one invocation and supports reversed session starts", () => {
  assert.equal(MEASURED_REPETITIONS, 7);
  assert.deepEqual(buildPairOrders("npm").slice(0, 3), [["npm", "bun"], ["bun", "npm"], ["npm", "bun"]]);
  assert.deepEqual(buildPairOrders("bun").slice(0, 2), [["bun", "npm"], ["npm", "bun"]]);
});

test("analyzer requires two independent sessions and uses seven-sample install medians", () => {
  const verdict = analyzeBenchmark([session("one", "/tmp/one", "npm"), session("two", "/tmp/two", "bun")]);
  assert.equal(verdict.pass, true);
  assert.equal(verdict.installs[0].cold.ratio, 0.5);
  assert.deepEqual(verdict.verify.map(({ wins, pass }) => ({ wins, pass })), [{ wins: 7, pass: true }, { wins: 7, pass: true }]);
});

test("analyzer fails closed on missing, failed, inventory, identity, or fingerprint mismatches", () => {
  const good = () => [session("one", "/tmp/one", "npm"), session("two", "/tmp/two", "bun")];
  assert.equal(analyzeBenchmark([good()[0]]).pass, false);
  const failed = good(); failed[0].installs.bun.cold.measured[3].exitCode = 1; assert.equal(analyzeBenchmark(failed).pass, false);
  const missing = good(); missing[0].verify.pop(); assert.equal(analyzeBenchmark(missing).pass, false);
  const inventory = good(); inventory[1].inventory.bun.packages.push("extra@1"); assert.equal(analyzeBenchmark(inventory).pass, false);
  const identity = good(); identity[1].sessionRoot = "/tmp/one"; assert.equal(analyzeBenchmark(identity).pass, false);
  const ordering = good(); ordering[1].startTool = "npm"; assert.equal(analyzeBenchmark(ordering).pass, false);
  const fingerprint = good(); fingerprint[1].sourceFingerprint.bun = "changed"; assert.equal(analyzeBenchmark(fingerprint).pass, false);
});
