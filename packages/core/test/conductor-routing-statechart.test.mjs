// Spike (#2659): conductor routing policy as an XState-v5-vocabulary JSON chart,
// tested differentially against evaluateConductorRouting (the routing authority).
// The runner and derive live here on purpose; nothing in src/ imports this file.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";

import { evaluateConductorRouting, ROUTING_OUTCOME } from "../src/loop/conductor-routing.mjs";
import { STATE } from "../src/loop/copilot-loop-state.mjs";
import { REVIEWER_STATE } from "../src/loop/reviewer-loop-state.mjs";

const chart = JSON.parse(
  readFileSync(new URL("./fixtures/conductor-routing-statechart.json", import.meta.url), "utf8"),
);

// ---------------------------------------------------------------------------
// derive: evaluator input -> chart context (+ target identity for the envelope)
// ---------------------------------------------------------------------------

function normalizeTarget(target) {
  if (!target || typeof target !== "object") return null;
  const { repo, pr } = target;
  if (typeof repo !== "string" || repo.trim().length === 0) return null;
  if (typeof pr !== "number" || !Number.isInteger(pr) || pr <= 0) return null;
  return { repo: repo.trim().toLowerCase(), pr };
}

function partialTarget(target) {
  if (!target || typeof target !== "object") return null;
  const repo = typeof target.repo === "string" && target.repo.trim().length > 0
    ? target.repo.trim().toLowerCase()
    : null;
  const pr = typeof target.pr === "number" && Number.isInteger(target.pr) && target.pr > 0 ? target.pr : null;
  return { repo, pr };
}

function derive(input) {
  const normalized = normalizeTarget(input.target);
  const confidence = input.sourceMode === "authoritative" || input.sourceMode === "snapshot"
    ? input.sourceMode
    : "local";
  return {
    context: {
      targetValid: normalized !== null,
      copilotState: input.copilotState,
      reviewerState: input.reviewerState,
      ownershipState: input.ownershipState ?? null,
      sourceMode: confidence,
      requiresLocalIsolation: input.requiresLocalIsolation ?? false,
    },
    targetIdentity: normalized ?? partialTarget(input.target),
    baseArgs: normalized,
  };
}

// ---------------------------------------------------------------------------
// Named guards (set membership mirrors conductor-routing.mjs internals)
// ---------------------------------------------------------------------------

const REVIEWER_ACTIVE = new Set([
  "review_requested", "determine_review_plan", "reviews_running", "merge_results",
  "draft_review_ready", "draft_review_posted", "waiting_for_user_submit", "review_invalidated",
]);
const REVIEWER_WAIT = new Set(["submitted_review", "waiting_for_author_followup", "waiting_for_re_request"]);
const COPILOT_WAIT = new Set(["waiting_for_copilot_review", "waiting_for_ci"]);
const COPILOT_STRONG_ACTIVE = new Set(["unresolved_feedback_present", "already_fixed_needs_reply_resolve"]);
const COPILOT_WEAK_ACTIVE = new Set(["pr_ready_no_feedback", "ready_to_rerequest_review"]);

const isBlank = (value) => typeof value !== "string" || value.trim().length === 0;
const liveOwner = (c) => c.ownershipState === "live_owner";
const copilotDraft = (c) => c.copilotState === "pr_draft";
const reviewerActive = (c) => REVIEWER_ACTIVE.has(c.reviewerState);
const copilotStrongActive = (c) => COPILOT_STRONG_ACTIVE.has(c.copilotState);
const copilotWeakActive = (c) => COPILOT_WEAK_ACTIVE.has(c.copilotState);

const GUARDS = {
  invalidTarget: (c) => c.targetValid === false,
  missingCopilotState: (c) => isBlank(c.copilotState),
  missingReviewerState: (c) => isBlank(c.reviewerState),
  duplicateOwners: (c) => c.ownershipState === "duplicate_local_owners",
  copilotDone: (c) => c.copilotState === "done",
  copilotNoPr: (c) => c.copilotState === "no_pr",
  reviewUnavailable: (c) => c.copilotState === "review_request_unavailable",
  copilotBlocked: (c) => c.copilotState === "blocked_needs_user_decision",
  reviewerBlocked: (c) => c.reviewerState === "blocked_needs_user_decision",
  copilotDraft,
  copilotDraftAndLiveOwner: (c) => copilotDraft(c) && liveOwner(c),
  waitingForCopilotReview: (c) => c.copilotState === "waiting_for_copilot_review",
  reviewerActive,
  reviewerActiveAndLiveOwner: (c) => reviewerActive(c) && liveOwner(c),
  copilotStrongActive,
  copilotStrongActiveAndLiveOwner: (c) => copilotStrongActive(c) && liveOwner(c),
  anyWait: (c) => COPILOT_WAIT.has(c.copilotState) || REVIEWER_WAIT.has(c.reviewerState),
  copilotWeakActive,
  copilotWeakActiveAndLiveOwner: (c) => copilotWeakActive(c) && liveOwner(c),
};

// ---------------------------------------------------------------------------
// Built-in runner: first guarded `always` arrow of `route` wins; read the final.
// ---------------------------------------------------------------------------

function runChart(input) {
  const { context, targetIdentity, baseArgs } = derive(input);
  const arrow = chart.states[chart.initial].always.find((a) => a.guard === undefined || GUARDS[a.guard](context));
  const final = chart.states[arrow.target];
  assert.equal(final.type, "final");
  return {
    arrow,
    final: arrow.target,
    result: {
      routingOutcome: arrow.target,
      outerAction: final.meta.outerAction,
      stopReason: arrow.meta.stopReason ?? null,
      handoffEnvelope: {
        targetIdentity,
        loopFamily: final.meta.loopFamily ?? null,
        entrypoint: final.meta.entrypoint ?? null,
        // pre-check arrows build the evaluator envelope without requiredArgs
        requiredArgs: arrow.meta.preCheck ? {} : { ...baseArgs },
        requiresLocalIsolation: context.requiresLocalIsolation,
        confidence: context.sourceMode,
      },
    },
  };
}

// Compared fields: everything except the free-text handoffEnvelope.reason.
function comparable(r) {
  const e = r.handoffEnvelope;
  return {
    routingOutcome: r.routingOutcome,
    outerAction: r.outerAction,
    stopReason: r.stopReason,
    handoffEnvelope: {
      targetIdentity: e.targetIdentity,
      loopFamily: e.loopFamily,
      entrypoint: e.entrypoint,
      requiredArgs: e.requiredArgs,
      requiresLocalIsolation: e.requiresLocalIsolation,
      confidence: e.confidence,
    },
  };
}

// ---------------------------------------------------------------------------
// Input product
// ---------------------------------------------------------------------------

const ABSENT = Symbol("absent");
const dims = {
  copilotState: [...Object.values(STATE), "", "unknown_sentinel_state"],
  reviewerState: [...Object.values(REVIEWER_STATE), "", "unknown_sentinel_state"],
  ownershipState: [ABSENT, "live_owner", "duplicate_local_owners", "some_other_ownership"],
  requiresLocalIsolation: [true, false],
  target: [{ repo: "Acme/Widgets", pr: 42 }, null, { repo: "Acme/Widgets", pr: -1 }],
  sourceMode: ["authoritative", "local", "snapshot", ABSENT],
};

function buildInputs() {
  let inputs = [{}];
  for (const [key, values] of Object.entries(dims)) {
    inputs = inputs.flatMap((base) => values.map((v) => (v === ABSENT ? { ...base } : { ...base, [key]: v })));
  }
  return inputs;
}

const inputs = buildInputs();
const expectedCount = Object.values(dims).reduce((n, v) => n * v.length, 1);
const runs = inputs.map((input) => ({ input, ...runChart(input), expected: evaluateConductorRouting(input) }));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("chart is plain JSON, uses only the XState v5 key allowlist, and every guard resolves", () => {
  const allowed = new Set(["id", "initial", "context", "states", "always", "target", "guard", "meta", "type"]);
  const checkKeys = (obj) => Object.keys(obj).forEach((k) => assert.ok(allowed.has(k), `key not allowed: ${k}`));
  checkKeys(chart);
  for (const [name, state] of Object.entries(chart.states)) {
    checkKeys(state);
    for (const arrow of state.always ?? []) {
      checkKeys(arrow);
      assert.ok(arrow.target in chart.states, `${name}: unknown target ${arrow.target}`);
      if (arrow.guard !== undefined) assert.equal(typeof GUARDS[arrow.guard], "function", arrow.guard);
    }
  }
  // chart comes from JSON.parse, so it holds plain data and no functions.
});

test("route arrows follow evaluator order and end in the 7 routing outcomes", () => {
  const arrows = chart.states.route.always;
  const expectedRules = ["0a", "0b", "0c", ...Array.from({ length: 17 }, (_, i) => i + 1)];
  assert.deepEqual(arrows.map((a) => a.meta.rule), expectedRules);
  arrows.forEach((a, i) => assert.equal(a.guard === undefined, i === arrows.length - 1));
  const finals = Object.entries(chart.states).filter(([, s]) => s.type === "final").map(([n]) => n);
  assert.deepEqual([...finals].sort(), Object.values(ROUTING_OUTCOME).sort());
});

test("differential: runner equals evaluateConductorRouting over the full input product", () => {
  assert.equal(inputs.length, expectedCount);
  const mismatches = runs.filter((r) => {
    try {
      assert.deepEqual(comparable(r.result), comparable(r.expected));
      return false;
    } catch {
      return true;
    }
  });
  console.log(`differential inputs=${inputs.length} (${Object.values(dims).map((v) => v.length).join(" x ")}) mismatches=${mismatches.length}`);
  assert.deepEqual(mismatches.map((m) => m.input), []);
});

test("requiresLocalIsolation passthrough: it never changes the outcome and finals echo it", () => {
  const key = (input) => JSON.stringify({ ...input, requiresLocalIsolation: undefined });
  const byKey = new Map();
  for (const r of runs) {
    const k = key(r.input);
    const prior = byKey.get(k);
    if (prior) assert.equal(prior.result.routingOutcome, r.result.routingOutcome);
    byKey.set(k, r);
    assert.equal(r.result.handoffEnvelope.requiresLocalIsolation, r.input.requiresLocalIsolation);
  }
});

test("fail-closed arrows match the evaluator", () => {
  const base = { target: { repo: "Acme/Widgets", pr: 7 }, copilotState: "pr_draft", reviewerState: "review_requested" };
  const cases = [
    ["0a", { ...base, target: { repo: "Acme/Widgets", pr: 0 } }, "unknown_state"],
    ["0a", { ...base, target: null }, "unknown_state"],
    ["0b", { ...base, copilotState: "  " }, "unknown_state"],
    ["0c", { ...base, reviewerState: "" }, "unknown_state"],
    [1, { ...base, ownershipState: "duplicate_local_owners" }, "ownership_conflict"],
  ];
  for (const [rule, input, stopReason] of cases) {
    const run = runChart(input);
    const expected = evaluateConductorRouting(input);
    assert.equal(run.arrow.meta.rule, rule);
    assert.equal(run.result.routingOutcome, ROUTING_OUTCOME.NEEDS_RECONCILE);
    assert.equal(run.result.stopReason, stopReason);
    assert.deepEqual(run.result.handoffEnvelope.targetIdentity, expected.handoffEnvelope.targetIdentity);
    assert.deepEqual(comparable(run.result), comparable(expected));
  }
});

test("coverage report: per arrow, per final, dead arrows, rule-17 fall-through", () => {
  const perArrow = new Map(chart.states.route.always.map((a) => [String(a.meta.rule), 0]));
  const perFinal = new Map(Object.keys(chart.states).filter((n) => n !== "route").map((n) => [n, 0]));
  const fallThrough = new Map();
  const fallThroughInputs = [];
  for (const r of runs) {
    perArrow.set(String(r.arrow.meta.rule), perArrow.get(String(r.arrow.meta.rule)) + 1);
    perFinal.set(r.final, perFinal.get(r.final) + 1);
    if (r.arrow.meta.rule === 17) {
      const i = r.input;
      fallThroughInputs.push(JSON.stringify(i));
      const known = Object.values(STATE).includes(i.copilotState) && Object.values(REVIEWER_STATE).includes(i.reviewerState);
      if (!known) continue;
      if (!fallThrough.has(i.copilotState)) fallThrough.set(i.copilotState, new Set());
      fallThrough.get(i.copilotState).add(i.reviewerState);
    }
  }
  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  assert.equal(sum(perArrow), inputs.length);
  assert.equal(sum(perFinal), inputs.length);
  const dead = [...perArrow].filter(([, n]) => n === 0).map(([rule]) => rule);
  assert.deepEqual(dead, []);
  const lines = [
    `coverage inputs=${inputs.length}`,
    ...[...perArrow].map(([rule, n]) => `arrow ${rule}: ${n}`),
    ...[...perFinal].map(([name, n]) => `final ${name}: ${n}`),
    `dead arrows: ${dead.length === 0 ? "none" : dead.join(", ")}`,
    "rule 17 fall-through (known copilot state -> known reviewer states):",
    ...[...fallThrough].map(([c, set]) => `  ${c} -> ${[...set].sort().join(", ")}`),
    `rule 17 fall-through, every input record (${fallThroughInputs.length}):`,
    ...fallThroughInputs.map((s) => `  ${s}`),
  ];
  const report = lines.join("\n");
  console.log(report);
  // The doc embeds this report verbatim; a stale doc fails here.
  const doc = readFileSync(new URL("../../../docs/conductor-routing-statechart-spike.md", import.meta.url), "utf8");
  assert.ok(doc.includes(report), "docs/conductor-routing-statechart-spike.md must embed the full coverage report");
});
