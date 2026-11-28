import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  enforceExternalHealthyWaitTimeout,
  enforcePersistentInternalWaitTimeout,
} from "../src/loop/timeout-policy.mjs";

test("external healthy wait errors name their own policy, not the persistent one", () => {
  for (const timeoutMs of [0, 1]) {
    assert.throws(
      () => enforceExternalHealthyWaitTimeout({ timeoutMs }),
      (error) => /external healthy/.test(error.message) && !/persistent/i.test(error.message),
    );
  }
});

test("persistent internal wait errors still name the persistent contract", () => {
  for (const timeoutMs of [0, 1]) {
    assert.throws(
      () => enforcePersistentInternalWaitTimeout({ timeoutMs }),
      (error) => /persistent internal/.test(error.message),
    );
  }
});

test("a timeout at or above the minimum passes and an explicit probe returns 0", () => {
  assert.equal(enforceExternalHealthyWaitTimeout({ timeoutMs: 1_800_000 }), 1_800_000);
  assert.equal(enforcePersistentInternalWaitTimeout({ explicitProbe: true }), 0);
});
