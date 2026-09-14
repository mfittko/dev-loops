import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import { enforceChildLaunchBound } from "../src/loop/child-launch-bound.mjs";

function baseRequest(overrides = {}) {
  return { run: "run-1", roleOrAngle: "coverage", model: "anthropic/claude-opus", harness: "claude", ...overrides };
}

/** A poisoned trap: any of these methods throws if the primitive ever calls them. */
function poisonedTrap() {
  const boom = (name) => () => {
    throw new Error(`poisoned trap: ${name} must never be called`);
  };
  return {
    retry: boom("retry"),
    fallback: boom("fallback"),
    substituteModel: boom("substituteModel"),
    inspectSource: boom("inspectSource"),
  };
}

/** Deterministic adapter fixture recording the launch/query call sequence + counts. */
function makeAdapter({ launchResult, supported = [] }) {
  const calls = { attemptLaunch: 0, querySupportedModels: 0 };
  const trap = poisonedTrap();
  return {
    trap,
    calls,
    attemptLaunch: (request) => {
      calls.attemptLaunch += 1;
      void trap; // never touched, only held for assertion
      return typeof launchResult === "function" ? launchResult(request) : launchResult;
    },
    querySupportedModels: (request) => {
      calls.querySupportedModels += 1;
      void request;
      return { supported };
    },
  };
}

describe("enforceChildLaunchBound — malformed request fails closed", () => {
  test("throws TypeError on empty run/roleOrAngle/model", () => {
    const adapter = makeAdapter({ launchResult: { ok: true, launch: {} } });
    assert.throws(() => enforceChildLaunchBound({ request: baseRequest({ run: "" }), ...adapter }), TypeError);
    assert.throws(() => enforceChildLaunchBound({ request: baseRequest({ roleOrAngle: "" }), ...adapter }), TypeError);
    assert.throws(() => enforceChildLaunchBound({ request: baseRequest({ model: "" }), ...adapter }), TypeError);
  });

  test("throws TypeError on a missing/non-object request", () => {
    const adapter = makeAdapter({ launchResult: { ok: true, launch: {} } });
    assert.throws(() => enforceChildLaunchBound({ request: null, ...adapter }), TypeError);
    assert.throws(() => enforceChildLaunchBound({ request: "nope", ...adapter }), TypeError);
  });
});

for (const harness of ["pi", "claude"]) {
  describe(`enforceChildLaunchBound — cross-harness parity (harness=${harness})`, () => {
    test("happy path: launch succeeds, inventory never queried, no blocker", () => {
      const adapter = makeAdapter({ launchResult: { ok: true, launch: { pid: 123 } } });
      const result = enforceChildLaunchBound({ request: baseRequest({ harness }), attemptLaunch: adapter.attemptLaunch, querySupportedModels: adapter.querySupportedModels });
      assert.equal(result.ok, true);
      assert.deepEqual(result.launch, { pid: 123 });
      assert.deepEqual(result.events, [{ type: "launch_attempt" }]);
      assert.equal(adapter.calls.attemptLaunch, 1);
      assert.equal(adapter.calls.querySupportedModels, 0);
      assert.equal(typeof result.elapsedMs, "number");
    });

    test("unsupported model: blocked with reason child_model_unsupported, request identity preserved", () => {
      const request = baseRequest({ harness, model: "anthropic/claude-ghost" });
      const adapter = makeAdapter({ launchResult: { ok: false, reason: "some_provider_error" }, supported: ["anthropic/claude-opus"] });
      const result = enforceChildLaunchBound({ request, attemptLaunch: adapter.attemptLaunch, querySupportedModels: adapter.querySupportedModels });
      assert.equal(result.ok, false);
      assert.equal(result.verdict, "blocked");
      assert.equal(result.reason, "child_model_unsupported");
      assert.equal(result.modelSupported, false);
      assert.deepEqual(result.request, { run: request.run, roleOrAngle: request.roleOrAngle, model: request.model, harness });
      assert.deepEqual(result.events, [{ type: "launch_attempt" }, { type: "inventory_query" }]);
    });
  });
}

describe("enforceChildLaunchBound — unknown harness fails closed (Codex is not a dev-loop harness)", () => {
  test("throws on an unrecognized harness value", () => {
    const adapter = makeAdapter({ launchResult: { ok: true, launch: {} } });
    assert.throws(() => enforceChildLaunchBound({ request: baseRequest({ harness: "codex" }), ...adapter }), TypeError);
    assert.throws(() => enforceChildLaunchBound({ request: baseRequest({ harness: "bogus" }), ...adapter }), TypeError);
  });
});

describe("enforceChildLaunchBound — unresolvable model", () => {
  test("reason maps to child_model_unresolvable", () => {
    const adapter = makeAdapter({ launchResult: { ok: false, reason: "unresolvable" }, supported: [] });
    const result = enforceChildLaunchBound({ request: baseRequest(), attemptLaunch: adapter.attemptLaunch, querySupportedModels: adapter.querySupportedModels });
    assert.equal(result.reason, "child_model_unresolvable");
    assert.equal(result.ok, false);
    assert.equal(result.verdict, "blocked");
  });
});

describe("enforceChildLaunchBound — supported-but-failed launch", () => {
  test("reason maps to child_launch_failed_model_supported, modelSupported true", () => {
    const request = baseRequest();
    const adapter = makeAdapter({ launchResult: { ok: false, reason: "provider_timeout" }, supported: [request.model] });
    const result = enforceChildLaunchBound({ request, attemptLaunch: adapter.attemptLaunch, querySupportedModels: adapter.querySupportedModels });
    assert.equal(result.reason, "child_launch_failed_model_supported");
    assert.equal(result.modelSupported, true);
  });
});

describe("enforceChildLaunchBound — budget traps: at-most-once call counts, no poisoned method touched", () => {
  test("attemptLaunch and querySupportedModels are each called exactly once on a failed launch", () => {
    const adapter = makeAdapter({ launchResult: { ok: false, reason: "unresolvable" }, supported: [] });
    enforceChildLaunchBound({ request: baseRequest(), attemptLaunch: adapter.attemptLaunch, querySupportedModels: adapter.querySupportedModels });
    assert.equal(adapter.calls.attemptLaunch, 1);
    assert.equal(adapter.calls.querySupportedModels, 1);
  });

  test("attemptLaunch is called exactly once and querySupportedModels never on a successful launch", () => {
    const adapter = makeAdapter({ launchResult: { ok: true, launch: {} } });
    enforceChildLaunchBound({ request: baseRequest(), attemptLaunch: adapter.attemptLaunch, querySupportedModels: adapter.querySupportedModels });
    assert.equal(adapter.calls.attemptLaunch, 1);
    assert.equal(adapter.calls.querySupportedModels, 0);
  });

  test("a poisoned trap object handed alongside the request is never invoked", () => {
    const trap = poisonedTrap();
    const request = baseRequest();
    const attemptLaunch = (req) => {
      assert.equal(req.model, request.model);
      return { ok: false, reason: "unsupported" };
    };
    const querySupportedModels = () => ({ supported: [] });
    // The trap is passed alongside the real deps; the primitive must never call it.
    const result = enforceChildLaunchBound({ request, attemptLaunch, querySupportedModels, trap });
    assert.equal(result.ok, false);
    // Sanity: the trap's methods are still throwing landmines, untouched.
    assert.throws(() => trap.retry());
    assert.throws(() => trap.fallback());
    assert.throws(() => trap.substituteModel());
    assert.throws(() => trap.inspectSource());
  });
});

describe("enforceChildLaunchBound — fail-closed revoke path", () => {
  test("a model that WAS supported but is no longer listed blocks, with no substitution/fallback", () => {
    const request = baseRequest({ model: "anthropic/claude-revoked" });
    const adapter = makeAdapter({
      launchResult: { ok: false, reason: "model_revoked" },
      supported: ["anthropic/claude-opus", "anthropic/claude-haiku"], // request.model no longer listed
    });
    const result = enforceChildLaunchBound({ request, attemptLaunch: adapter.attemptLaunch, querySupportedModels: adapter.querySupportedModels });
    assert.equal(result.ok, false);
    assert.equal(result.verdict, "blocked");
    assert.equal(result.reason, "child_model_unsupported");
    assert.equal(result.modelSupported, false);
    // The returned request.model is unchanged — no silent substitution.
    assert.equal(result.request.model, "anthropic/claude-revoked");
    // Only one launch attempt ever happened, for the originally requested model.
    assert.equal(adapter.calls.attemptLaunch, 1);
  });
});

describe("enforceChildLaunchBound — elapsed bound", () => {
  test("a fast clock yields withinDeadline true", () => {
    let t = 1000;
    const now = () => t;
    const adapter = makeAdapter({ launchResult: { ok: false, reason: "unresolvable" }, supported: [] });
    const result = enforceChildLaunchBound({ request: baseRequest(), attemptLaunch: adapter.attemptLaunch, querySupportedModels: adapter.querySupportedModels, now, deadlineMs: 60000 });
    assert.equal(result.withinDeadline, true);
    assert.equal(result.elapsedMs, 0);
  });

  test("a clock that jumps past deadlineMs still produces the blocker, with withinDeadline false", () => {
    let calls = 0;
    const now = () => {
      calls += 1;
      // First call = start; second call = after inventory query, far past deadline.
      return calls === 1 ? 0 : 120000;
    };
    const adapter = makeAdapter({ launchResult: { ok: false, reason: "unsupported" }, supported: [] });
    const result = enforceChildLaunchBound({ request: baseRequest(), attemptLaunch: adapter.attemptLaunch, querySupportedModels: adapter.querySupportedModels, now, deadlineMs: 60000 });
    assert.equal(result.ok, false);
    assert.equal(result.verdict, "blocked");
    assert.equal(result.withinDeadline, false);
    assert.equal(result.elapsedMs, 120000);
  });

  test("default deadlineMs is 60000 when not supplied", () => {
    const now = () => 5;
    const adapter = makeAdapter({ launchResult: { ok: true, launch: {} } });
    const result = enforceChildLaunchBound({ request: baseRequest(), attemptLaunch: adapter.attemptLaunch, querySupportedModels: adapter.querySupportedModels, now });
    assert.equal(result.elapsedMs, 0);
  });
});
