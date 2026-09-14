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

/**
 * Deterministic adapter fixture recording the launch/query call sequence,
 * counts, and the exact request argument each received (so a test can assert
 * both calls carried the failed request's identity, not a substituted one).
 */
function makeAdapter({ launchResult, supported = [] }) {
  const calls = { attemptLaunch: 0, querySupportedModels: 0 };
  const requests = { attemptLaunch: null, querySupportedModels: null };
  const trap = poisonedTrap();
  return {
    trap,
    calls,
    requests,
    attemptLaunch: (request) => {
      calls.attemptLaunch += 1;
      requests.attemptLaunch = request;
      void trap; // never touched, only held for assertion
      return typeof launchResult === "function" ? launchResult(request) : launchResult;
    },
    querySupportedModels: (request) => {
      calls.querySupportedModels += 1;
      requests.querySupportedModels = request;
      return { supported };
    },
  };
}

/**
 * Build one options object exposing the two sanctioned dependencies
 * (attemptLaunch, querySupportedModels) alongside the four forbidden
 * operations, all as spies. `log` records every sanctioned-dependency call
 * in order (the complete recorded interaction); `forbiddenCalls` counts each
 * forbidden op so the test can assert it stayed at 0 rather than merely
 * asserting the op throws if touched.
 */
function makeSpyDependencies({ launchResult, supported = [] }) {
  const log = [];
  const forbiddenCalls = { retry: 0, fallback: 0, substituteModel: 0, inspectSource: 0 };
  return {
    log,
    forbiddenCalls,
    attemptLaunch: (request) => {
      log.push("attemptLaunch");
      return typeof launchResult === "function" ? launchResult(request) : launchResult;
    },
    querySupportedModels: (request) => {
      log.push("querySupportedModels");
      void request;
      return { supported };
    },
    retry: () => { forbiddenCalls.retry += 1; },
    fallback: () => { forbiddenCalls.fallback += 1; },
    substituteModel: () => { forbiddenCalls.substituteModel += 1; },
    inspectSource: () => { forbiddenCalls.inspectSource += 1; },
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

for (const harness of ["pi", "claude", "codex"]) {
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
      const normalized = { run: request.run, roleOrAngle: request.roleOrAngle, model: request.model, harness };
      assert.deepEqual(result.request, normalized);
      assert.deepEqual(result.events, [{ type: "launch_attempt" }, { type: "inventory_query" }]);
      // The inventory query is for the SAME failed (run, roleOrAngle, model)
      // request that was launched — not a substituted or partial one.
      assert.deepEqual(adapter.requests.attemptLaunch, normalized);
      assert.deepEqual(adapter.requests.querySupportedModels, normalized);
    });
  });
}

describe("enforceChildLaunchBound — unknown harness fails closed", () => {
  test("throws on an unrecognized harness value", () => {
    const adapter = makeAdapter({ launchResult: { ok: true, launch: {} } });
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

  test("success path: only attemptLaunch is invoked; forbidden ops (retry/fallback/substituteModel/inspectSource) are never called", () => {
    const spies = makeSpyDependencies({ launchResult: { ok: true, launch: { pid: 1 } } });
    const result = enforceChildLaunchBound({
      request: baseRequest(),
      attemptLaunch: spies.attemptLaunch,
      querySupportedModels: spies.querySupportedModels,
      retry: spies.retry,
      fallback: spies.fallback,
      substituteModel: spies.substituteModel,
      inspectSource: spies.inspectSource,
    });
    assert.equal(result.ok, true);
    // The complete recorded interaction is exactly the sanctioned sequence.
    assert.deepEqual(spies.log, ["attemptLaunch"]);
    // The forbidden operations, handed alongside the real deps, are never called.
    assert.deepEqual(spies.forbiddenCalls, { retry: 0, fallback: 0, substituteModel: 0, inspectSource: 0 });
  });

  test("failure path: attemptLaunch then querySupportedModels only; forbidden ops never called; request.model unchanged", () => {
    const request = baseRequest();
    const spies = makeSpyDependencies({ launchResult: { ok: false, reason: "unsupported" }, supported: [] });
    const result = enforceChildLaunchBound({
      request,
      attemptLaunch: spies.attemptLaunch,
      querySupportedModels: spies.querySupportedModels,
      retry: spies.retry,
      fallback: spies.fallback,
      substituteModel: spies.substituteModel,
      inspectSource: spies.inspectSource,
    });
    assert.equal(result.ok, false);
    // The complete recorded interaction is exactly the sanctioned sequence.
    assert.deepEqual(spies.log, ["attemptLaunch", "querySupportedModels"]);
    // The forbidden operations, handed alongside the real deps, are never called.
    assert.deepEqual(spies.forbiddenCalls, { retry: 0, fallback: 0, substituteModel: 0, inspectSource: 0 });
    // The returned request.model is unchanged — no silent substitution.
    assert.equal(result.request.model, request.model);
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

describe("enforceChildLaunchBound — launch failure detail preserved", () => {
  test("blocker carries the original failed launch result verbatim alongside the mapped reason", () => {
    const request = baseRequest();
    const failedLaunch = { ok: false, reason: "provider_timeout", error: { code: "ETIMEDOUT", message: "provider did not respond" } };
    const adapter = makeAdapter({ launchResult: failedLaunch, supported: [request.model] });
    const result = enforceChildLaunchBound({ request, attemptLaunch: adapter.attemptLaunch, querySupportedModels: adapter.querySupportedModels });
    assert.equal(result.reason, "child_launch_failed_model_supported");
    assert.deepEqual(result.launchFailureDetail, failedLaunch);
  });
});

describe("enforceChildLaunchBound — supported-set inventory shapes", () => {
  test("a bare array inventory resolves modelSupported true for a listed model", () => {
    const request = baseRequest();
    const adapter = makeAdapter({ launchResult: { ok: false, reason: "unsupported" } });
    adapter.querySupportedModels = () => [request.model];
    const result = enforceChildLaunchBound({ request, attemptLaunch: adapter.attemptLaunch, querySupportedModels: adapter.querySupportedModels });
    assert.equal(result.modelSupported, true);
  });

  test("a Set inventory resolves modelSupported true for a listed model", () => {
    const request = baseRequest();
    const adapter = makeAdapter({ launchResult: { ok: false, reason: "unsupported" } });
    adapter.querySupportedModels = () => new Set([request.model]);
    const result = enforceChildLaunchBound({ request, attemptLaunch: adapter.attemptLaunch, querySupportedModels: adapter.querySupportedModels });
    assert.equal(result.modelSupported, true);
  });

  test("a malformed/non-list inventory fails closed: modelSupported false, blocked", () => {
    const request = baseRequest();
    const adapter = makeAdapter({ launchResult: { ok: false, reason: "unsupported" } });
    adapter.querySupportedModels = () => "not-a-list";
    const result = enforceChildLaunchBound({ request, attemptLaunch: adapter.attemptLaunch, querySupportedModels: adapter.querySupportedModels });
    assert.equal(result.ok, false);
    assert.equal(result.verdict, "blocked");
    assert.equal(result.modelSupported, false);
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

  test("a slow SUCCESSFUL launch still reports withinDeadline false", () => {
    let calls = 0;
    const now = () => {
      calls += 1;
      return calls === 1 ? 0 : 120000;
    };
    const adapter = makeAdapter({ launchResult: { ok: true, launch: { pid: 1 } } });
    const result = enforceChildLaunchBound({ request: baseRequest(), attemptLaunch: adapter.attemptLaunch, querySupportedModels: adapter.querySupportedModels, now, deadlineMs: 60000 });
    assert.equal(result.ok, true);
    assert.equal(result.elapsedMs, 120000);
    assert.equal(result.withinDeadline, false);
  });
});
