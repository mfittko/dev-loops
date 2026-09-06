import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { HARNESSES, SCENARIO_NAMES, runScenario } from "./fixtures/spec-authority/harness-cases.mjs";

// AC11 (issue 2008 / ADR-0061): spec-authority.mjs is pure and never reads a
// harness adapter, so authority/rejection/routing/escalation/invalidation/
// re-entry behavior is IDENTICAL across Pi, Claude Code, and Codex by
// construction. This test makes that explicit and regression-pinned: it
// drives the SAME scenario through each harness adapter and asserts
// byte-identical output.
describe("spec-authority cross-harness parity (Pi / Claude Code / Codex, issue 2008 AC11)", () => {
  const harnessNames = Object.keys(HARNESSES);

  test("every harness in the fixture is a real, complete HarnessAdapter", () => {
    for (const name of harnessNames) {
      const adapter = HARNESSES[name]();
      for (const method of ["getCwd", "getEnv", "isInteractive", "isInsidePi", "getRepoRoot"]) {
        assert.equal(typeof adapter[method], "function", `${name} adapter must expose ${method}`);
      }
    }
  });

  for (const scenario of SCENARIO_NAMES) {
    test(`${scenario} is byte-identical across every harness`, () => {
      const results = harnessNames.map((name) => ({ name, result: runScenario(scenario, HARNESSES[name]()) }));
      const [first, ...rest] = results;
      for (const { name, result } of rest) {
        assert.deepEqual(
          result,
          first.result,
          `scenario ${JSON.stringify(scenario)} diverged: ${first.name} vs ${name}`,
        );
      }
      // Byte-level (not just deepEqual) parity, since digests/ids are the
      // load-bearing values here.
      const serialized = results.map(({ result }) => JSON.stringify(result));
      assert.ok(
        serialized.every((s) => s === serialized[0]),
        `scenario ${JSON.stringify(scenario)} produced non-identical JSON bytes across harnesses`,
      );
    });
  }
});
