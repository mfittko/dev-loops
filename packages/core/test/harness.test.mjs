import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import {
  createHarnessAdapter,
  isHarnessAdapter,
  createPiAdapter,
  createNoopAdapter,
} from "../src/harness/index.mjs";

test("createHarnessAdapter validates required methods", () => {
  assert.throws(
    () => createHarnessAdapter({ getCwd: () => "/", getEnv: () => ({}), isInteractive: () => false, isInsidePi: () => false }),
    /missing required method "getRepoRoot"/,
  );
  assert.throws(() => createHarnessAdapter(null), /impl must be an object/);
  assert.throws(() => createHarnessAdapter("nope"), /impl must be an object/);
});

test("isHarnessAdapter recognizes complete adapters", () => {
  const adapter = createNoopAdapter();
  assert.equal(isHarnessAdapter(adapter), true);
  assert.equal(isHarnessAdapter({ getCwd: () => "/" }), false);
  assert.equal(isHarnessAdapter(null), false);
  assert.equal(isHarnessAdapter("adapter"), false);
});

test("noop adapter returns deterministic fallback values", () => {
  const cwd = path.resolve("/tmp/noop-test");
  const env = { FOO: "bar" };
  const adapter = createNoopAdapter({ cwd, env });

  assert.equal(adapter.getCwd(), cwd);
  assert.deepEqual(adapter.getEnv(), env);
  assert.equal(adapter.isInteractive(), false);
  assert.equal(adapter.isInsidePi(), false);
  assert.equal(adapter.getRepoRoot(), cwd);
});

test("noop adapter object is frozen", () => {
  const adapter = createNoopAdapter();
  assert.throws(() => { adapter.getCwd = () => "/hijack"; }, TypeError);
});

test("pi adapter exposes supplied cwd and env", () => {
  const cwd = path.resolve("/tmp/pi-test");
  const env = { PI_SESSION: "1", CI: "true" };
  const adapter = createPiAdapter({ cwd, env });

  assert.equal(adapter.getCwd(), cwd);
  assert.deepEqual(adapter.getEnv(), env);
});

test("pi adapter resolves repo root via git", () => {
  const adapter = createPiAdapter();
  const repoRoot = adapter.getRepoRoot();
  assert.ok(path.isAbsolute(repoRoot), "repo root should be absolute");
  assert.ok(repoRoot.length > 0, "repo root should be non-empty");
});

test("pi adapter isInteractive respects env overrides", () => {
  assert.equal(createPiAdapter({ env: { PI_INTERACTIVE: "0" } }).isInteractive(), false);
  assert.equal(createPiAdapter({ env: { PI_INTERACTIVE: "1" } }).isInteractive(), true);
  assert.equal(createPiAdapter({ env: { CI: "true" } }).isInteractive(), false);
  assert.equal(createPiAdapter({ env: {} }).isInteractive(), true);
});

test("pi adapter isInsidePi is true when PI_SESSION=1", () => {
  assert.equal(createPiAdapter({ env: { PI_SESSION: "1" } }).isInsidePi(), true);
  assert.equal(createPiAdapter({ env: {} }).isInsidePi(), false);
});
