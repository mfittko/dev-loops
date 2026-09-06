import assert from "node:assert/strict";
import { test } from "bun:test";

// Integration smoke tests for queue mode — mostly imports to verify
// the modules load and export correctly without runtime side effects.

test("queue-state module loads", async () => {
  const mod = await import("../../packages/core/src/loop/queue-state.mjs");
  assert.equal(typeof mod.createEntry, "function");
  assert.equal(typeof mod.transitionEntry, "function");
  assert.equal(typeof mod.topologicalOrder, "function");
  assert.equal(typeof mod.nextReadyEntry, "function");
  assert.equal(typeof mod.readQueue, "function");
  assert.equal(typeof mod.writeQueue, "function");
});

test("queue-driver module loads", async () => {
  const mod = await import("../../packages/core/src/loop/queue-driver.mjs");
  assert.equal(typeof mod.runQueue, "function");
  assert.equal(typeof mod.classifyFailure, "function");
  assert.equal(typeof mod.isRecoverable, "function");
});

test("queue-parallel module loads", async () => {
  const mod = await import("../../packages/core/src/loop/queue-parallel.mjs");
  assert.equal(typeof mod.computeOverlapGroups, "function");
  assert.equal(typeof mod.scheduleParallelWaves, "function");
  assert.equal(typeof mod.computeParallelSchedule, "function");
});
