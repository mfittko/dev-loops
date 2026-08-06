import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMainCheckoutFastForwardCommand,
  MAIN_CHECKOUT_FF_FETCH_TIMEOUT_MS,
  MAIN_CHECKOUT_FF_MERGE_TIMEOUT_MS,
} from "../src/loop/main-checkout-ff.mjs";

test("buildMainCheckoutFastForwardCommand emits the exact ff-only command (path single-quoted)", () => {
  assert.equal(
    buildMainCheckoutFastForwardCommand("/Users/x/dev-loops"),
    "git -C '/Users/x/dev-loops' fetch origin main && git -C '/Users/x/dev-loops' merge --ff-only origin/main",
  );
});

test("buildMainCheckoutFastForwardCommand quotes a path containing a space", () => {
  assert.equal(
    buildMainCheckoutFastForwardCommand("/Users/My User/dev-loops"),
    "git -C '/Users/My User/dev-loops' fetch origin main && git -C '/Users/My User/dev-loops' merge --ff-only origin/main",
  );
});

test("buildMainCheckoutFastForwardCommand escapes a single quote in the path", () => {
  const cmd = buildMainCheckoutFastForwardCommand("/a'b");
  assert.ok(cmd.startsWith("git -C '/a'\\''b' fetch"), `unexpected command: ${cmd}`);
});

test("the ff timeouts are finite numbers", () => {
  assert.equal(Number.isFinite(MAIN_CHECKOUT_FF_FETCH_TIMEOUT_MS), true);
  assert.equal(Number.isFinite(MAIN_CHECKOUT_FF_MERGE_TIMEOUT_MS), true);
  assert.ok(MAIN_CHECKOUT_FF_FETCH_TIMEOUT_MS > 0);
  assert.ok(MAIN_CHECKOUT_FF_MERGE_TIMEOUT_MS > 0);
});
