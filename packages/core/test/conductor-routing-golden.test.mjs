// Golden regression net: pins evaluateConductorRouting over the full input product.
// The fixture rows cover (copilotState, reviewerState, ownershipState) for a valid
// target; target shape, requiresLocalIsolation and sourceMode follow the contract's
// passthrough and fail-closed rules. The free-text reason is not compared.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";

import { evaluateConductorRouting } from "../src/loop/conductor-routing.mjs";
import { ABSENT, buildInputs, dims } from "./helpers/conductor-routing-inputs.mjs";

const golden = JSON.parse(
  readFileSync(new URL("./fixtures/conductor-routing-golden.json", import.meta.url), "utf8"),
);
const rowKey = (c, r, o) => JSON.stringify([c, r, o]);
const rows = new Map(golden.map((row) => [rowKey(row.copilotState, row.reviewerState, row.ownershipState), row]));

function validTarget(target) {
  if (!target || typeof target !== "object") return null;
  const { repo, pr } = target;
  if (typeof repo !== "string" || repo.trim().length === 0) return null;
  if (!Number.isInteger(pr) || pr <= 0) return null;
  return { repo: repo.trim().toLowerCase(), pr };
}

function partialTarget(target) {
  if (!target || typeof target !== "object") return null;
  const repo = typeof target.repo === "string" && target.repo.trim().length > 0 ? target.repo.trim().toLowerCase() : null;
  const pr = Number.isInteger(target.pr) && target.pr > 0 ? target.pr : null;
  return { repo, pr };
}

function expectedFor(input) {
  const target = validTarget(input.target);
  const confidence = ["authoritative", "snapshot"].includes(input.sourceMode) ? input.sourceMode : "local";
  const requiresLocalIsolation = input.requiresLocalIsolation ?? false;
  const common = { requiresLocalIsolation, confidence };
  if (!target) {
    return {
      routingOutcome: "needs_reconcile", outerAction: "stop", stopReason: "unknown_state",
      handoffEnvelope: { targetIdentity: partialTarget(input.target), loopFamily: null, entrypoint: null, requiredArgs: {}, ...common },
    };
  }
  const row = rows.get(rowKey(input.copilotState, input.reviewerState, input.ownershipState ?? null));
  assert.ok(row, `no golden row for ${JSON.stringify(input)}`);
  return {
    routingOutcome: row.routingOutcome, outerAction: row.outerAction, stopReason: row.stopReason,
    handoffEnvelope: {
      targetIdentity: target, loopFamily: row.loopFamily, entrypoint: row.entrypoint,
      requiredArgs: row.requiredArgs === "empty" ? {} : { ...target }, ...common,
    },
  };
}

function comparable(r) {
  const { reason: _reason, ...envelope } = r.handoffEnvelope;
  return { ...r, handoffEnvelope: envelope };
}

test("golden fixture covers every (copilotState, reviewerState, ownershipState) combination once", () => {
  const expected = dims.copilotState.length * dims.reviewerState.length * dims.ownershipState.length;
  assert.equal(golden.length, expected);
  assert.equal(rows.size, expected);
  assert.ok(dims.ownershipState.includes(ABSENT));
});

test("golden: evaluator matches the pinned table over the full input product", () => {
  const inputs = buildInputs();
  const mismatches = inputs.filter((input) => {
    try {
      assert.deepEqual(comparable(evaluateConductorRouting(input)), expectedFor(input));
      return false;
    } catch {
      return true;
    }
  });
  console.log(`golden inputs=${inputs.length} mismatches=${mismatches.length}`);
  assert.equal(inputs.length, 24480);
  assert.deepEqual(mismatches, []);
});
