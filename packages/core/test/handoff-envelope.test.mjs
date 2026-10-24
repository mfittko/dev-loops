import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  buildDevLoopHandoffEnvelope,
  validateHandoffEnvelope,
  ACCEPTANCE_TEMPLATES,
  ENVELOPE_HANDOFF_VERSION,
  STRATEGY_DEFAULT_STOP_RULES,
  acceptanceKey,
  deriveTarget,
  deriveStopRules,
  deriveGateConfig,
  deriveCwd,
  deriveRequiredReads,
  normalizeGateState,
  normalizeRetrospectiveFindings,
  resolveSubGate,
  lookupAcceptanceTemplate,
  buildWorktreeSlug,
  flattenSlugSegment,
  resolveWorktreePath,
  UNIT_BOUNDARY,
} from "../src/loop/handoff-envelope.mjs";

import {
  DEV_LOOP_TARGET_KIND,
  INTERNAL_DEV_LOOP_STRATEGY,
  DEV_LOOP_EXECUTION_MODE,
} from "../src/loop/public-dev-loop-routing-contract.mjs";
import { resolveAuthoritativeStartupResumeBundle } from "../src/loop/public-dev-loop-routing.mjs";

// ---------------------------------------------------------------------------
// Helpers to build fixture inputs
// ---------------------------------------------------------------------------

function issueBundle(issue, opts = {}) {
  return {
    bundle: {
      selectedStrategy: opts.strategy ?? INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP,
      executionMode: opts.executionMode ?? DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF,
      nextAction: opts.nextAction ?? "Draft PR implementation.",
      requiredReads: opts.requiredReads ?? ["skills/docs/public-dev-loop-contract.md"],
      activeArtifact: {
        kind: DEV_LOOP_TARGET_KIND.ISSUE,
        issue,
        pr: opts.pr ?? null,
        linkedPr: opts.linkedPr ?? null,
        branch: opts.branch ?? null,
        phase: null,
      },
    },
  };
}

function prBundle(pr, opts = {}) {
  return {
    bundle: {
      selectedStrategy: opts.strategy ?? INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP,
      executionMode: opts.executionMode ?? DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF,
      nextAction: opts.nextAction ?? "Follow up on PR.",
      requiredReads: opts.requiredReads ?? ["skills/copilot-pr-followup/SKILL.md"],
      activeArtifact: {
        kind: DEV_LOOP_TARGET_KIND.PR,
        pr,
        issue: opts.issue ?? null,
        branch: opts.branch ?? null,
      },
    },
  };
}

function localBranchBundle(branch, opts = {}) {
  return {
    bundle: {
      selectedStrategy: opts.strategy ?? INTERNAL_DEV_LOOP_STRATEGY.LOCAL_IMPLEMENTATION,
      executionMode: opts.executionMode ?? DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF,
      nextAction: opts.nextAction ?? "Implement changes locally.",
      requiredReads: opts.requiredReads ?? ["skills/local-implementation/SKILL.md"],
      activeArtifact: {
        kind: DEV_LOOP_TARGET_KIND.LOCAL_BRANCH,
        branch,
        issue: opts.issue ?? null,
        linkedPr: opts.linkedPr ?? null,
      },
    },
  };
}

function localPhaseBundle(phase, opts = {}) {
  return {
    bundle: {
      selectedStrategy: opts.strategy ?? INTERNAL_DEV_LOOP_STRATEGY.LOCAL_IMPLEMENTATION,
      executionMode: opts.executionMode ?? DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF,
      nextAction: opts.nextAction ?? "Implement phase.",
      requiredReads: opts.requiredReads ?? ["skills/local-implementation/SKILL.md"],
      activeArtifact: {
        kind: DEV_LOOP_TARGET_KIND.LOCAL_PHASE,
        phase,
        issue: opts.issue ?? null,
        linkedPr: opts.linkedPr ?? null,
      },
    },
  };
}

function nullStrategyBundle() {
  return {
    bundleKind: "needs_reconcile",
    selectedStrategy: "none",
    bundle: {
      bundleKind: "needs_reconcile",
      selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.NONE,
      routeKind: "needs_reconcile",
      selectedGate: "fail_closed_reconcile",
      executionMode: DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF,
      nextAction: "Reconcile the canonical state before routing.",
      requiredReads: [],
      activeArtifact: {
        kind: DEV_LOOP_TARGET_KIND.ISSUE,
        issue: 1,
      },
    },
  };
}

const defaultSettings = {
  workflow: { asyncStartMode: "required", requireDraftFirst: true },
  refinement: { maxCopilotRounds: 5 },
  autonomy: { stopAt: ["draft-pr", "merge"] },
  gates: {
    draft: {
      angles: ["scope", "coverage", "correctness"],
      blockCleanOnFindingSeverities: ["high"],
      requireCi: true,
    },
  },
};

// Pin env to {} so envelope-building tests stay deterministic regardless of the ambient harness
// (buildDevLoopHandoffEnvelope defaults options.env to process.env; under CLAUDECODE=1 a `required`
// async-start mode resolves to an `allowed` effective value — #834). Tests that exercise Claude
// behavior override `env` explicitly.
const defaultOptions = { repoSlug: "owner/repo", env: {} };

// ===========================================================================
// 1. fn-exists and basic shape
// ===========================================================================

test("fn-exists: buildDevLoopHandoffEnvelope is a function", () => {
  assert.equal(typeof buildDevLoopHandoffEnvelope, "function");
});

test("async-start (#834): configured mode echoed; not relaxed off the Claude harness", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    {},
    { ...defaultOptions, env: {} }, // no CLAUDECODE
  );
  assert.equal(env.asyncStartMode, "required", "configured value unchanged (back-compat)");
  assert.equal(env.asyncStartEffective, "required", "effective equals configured off-harness");
  assert.equal(env.asyncStartRelaxedBy, null, "no relaxation flag when nothing was relaxed");
});

test("async-start (#834): required is relaxed to allowed under the Claude harness, with a flag", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    {},
    { ...defaultOptions, env: { CLAUDECODE: "1" } },
  );
  assert.equal(env.asyncStartMode, "required", "configured value still echoed verbatim");
  assert.equal(env.asyncStartEffective, "allowed", "effective is allowed under Claude");
  assert.equal(env.asyncStartRelaxedBy, "claude-harness", "relaxation source surfaced");
});

test("async-start (#834): already-allowed config is not flagged as relaxed under Claude", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    { ...defaultSettings, workflow: { asyncStartMode: "allowed", requireDraftFirst: true } },
    {},
    { ...defaultOptions, env: { CLAUDECODE: "1" } },
  );
  assert.equal(env.asyncStartMode, "allowed");
  assert.equal(env.asyncStartEffective, "allowed");
  assert.equal(env.asyncStartRelaxedBy, null, "no relaxation when already allowed");
});

test("shape: envelope has correct top-level keys", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    {},
    defaultOptions
  );

  assert.equal(env.handoffVersion, ENVELOPE_HANDOFF_VERSION);
  assert.equal(typeof env.gateState.derivedAt, "string");
  assert.ok(env.gateState.derivedAt.endsWith("Z") || env.gateState.derivedAt.includes("T"));
  assert.equal(typeof env.target, "object");
  assert.equal(typeof env.currentGate, "string");
  assert.equal(typeof env.executionMode, "string");
  assert.equal(typeof env.nextAction, "string");
  assert.ok(Array.isArray(env.requiredReads));
  assert.ok(Array.isArray(env.stopRules));
  assert.equal(typeof env.asyncStartMode, "string");
  assert.equal(typeof env.requireDraftFirst, "boolean");
  assert.equal(typeof env.acceptance, "object");
  assert.equal(typeof env.control, "object");
});

test("shape: acceptance block has criteria, evidence, maxFinalizationTurns", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    {},
    defaultOptions
  );

  assert.ok(Array.isArray(env.acceptance.criteria));
  assert.ok(env.acceptance.criteria.length > 0);
  assert.ok(Array.isArray(env.acceptance.evidence));
  assert.ok(env.acceptance.evidence.length > 0);
  assert.equal(typeof env.acceptance.maxFinalizationTurns, "number");
  assert.ok(env.acceptance.maxFinalizationTurns > 0);
});

// ===========================================================================
// 2. Strategy/gate combo tests
// ===========================================================================

test("combo: copilot_pr_followup + draft (default sub-gate)", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    {},
    defaultOptions
  );
  assert.equal(env.currentGate, "draft");
  assert.ok(env.acceptance.criteria.some((c) => c.id === "ac-check"));
  assert.ok(env.acceptance.criteria.some((c) => c.id === "scope"));
  assert.equal(env.acceptance.maxFinalizationTurns, 4);
});

test("combo: copilot_pr_followup + draft (explicit sub-gate)", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    { currentSubGate: "draft" },
    defaultOptions
  );
  assert.equal(env.currentGate, "draft");
});

test("combo: copilot_pr_followup + watch", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    { currentSubGate: "watch" },
    defaultOptions
  );
  assert.equal(env.currentGate, "watch");
  assert.ok(env.acceptance.criteria.some((c) => c.id === "copilot-activity"));
  assert.ok(env.acceptance.criteria.some((c) => c.id === "no-stuck-watch"));
  assert.equal(env.acceptance.maxFinalizationTurns, 2);
});

test("combo: copilot_pr_followup + pre-approval", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    { currentSubGate: "pre-approval" },
    defaultOptions
  );
  assert.equal(env.currentGate, "pre-approval");
  assert.ok(env.acceptance.criteria.some((c) => c.id === "full-gate-chain"));
  assert.ok(env.acceptance.criteria.some((c) => c.id === "clean-verdict"));
  assert.equal(env.acceptance.maxFinalizationTurns, 6);
  assert.ok(env.acceptance.evidence.includes("residual-risks"));
});

test("combo: final_approval", () => {
  const env = buildDevLoopHandoffEnvelope(
    prBundle(10, { strategy: INTERNAL_DEV_LOOP_STRATEGY.FINAL_APPROVAL }),
    defaultSettings,
    {},
    defaultOptions
  );
  assert.equal(env.currentGate, "default");
  assert.ok(env.acceptance.criteria.some((c) => c.id === "gate-evidence"));
  assert.ok(env.acceptance.criteria.some((c) => c.id === "human-confirmation"));
  assert.equal(env.acceptance.maxFinalizationTurns, 2);
  assert.ok(env.acceptance.evidence.includes("manual-notes"));
});

test("combo: local_implementation (branch)", () => {
  const env = buildDevLoopHandoffEnvelope(
    localBranchBundle("feature/x"),
    defaultSettings,
    {},
    defaultOptions
  );
  assert.equal(env.currentGate, "default");
  assert.ok(env.acceptance.criteria.some((c) => c.id === "phase-ac"));
  assert.ok(env.acceptance.criteria.some((c) => c.id === "validation-green"));
  assert.ok(env.acceptance.criteria.some((c) => c.id === "validation-green" && c.must.includes("dev-loops gate resolve-validation")));
  assert.equal(env.acceptance.maxFinalizationTurns, 6);
  assert.ok(env.acceptance.evidence.includes("changed-files"));
});

test("combo: local_implementation (phase)", () => {
  const env = buildDevLoopHandoffEnvelope(
    localPhaseBundle("10"),
    defaultSettings,
    {},
    defaultOptions
  );
  assert.equal(env.target.phase, "10");
  assert.ok(env.acceptance.evidence.includes("changed-files"));
});

test("combo: SPIKE-RELAXED-GATE-PROFILE — a spike run resolves the spike gate (#1628)", () => {
  const resolverOutput = {
    ...localPhaseBundle("/tmp/spike.md"),
    spikeIntakeState: "spike_ready_for_exit",
  };
  const env = buildDevLoopHandoffEnvelope(
    resolverOutput,
    defaultSettings,
    {},
    defaultOptions
  );
  assert.equal(env.currentGate, "spike");
  assert.ok(env.acceptance.criteria.some((c) => c.id === "spike-recorded"));
});

test("combo: issue_intake", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(1, { strategy: INTERNAL_DEV_LOOP_STRATEGY.ISSUE_INTAKE }),
    defaultSettings,
    {},
    defaultOptions
  );
  assert.equal(env.currentGate, "default");
  assert.ok(env.acceptance.criteria.some((c) => c.id === "contract-compliance"));
});

test("combo: external_pr_followup", () => {
  const env = buildDevLoopHandoffEnvelope(
    prBundle(10, { strategy: INTERNAL_DEV_LOOP_STRATEGY.EXTERNAL_PR_FOLLOWUP }),
    defaultSettings,
    {},
    defaultOptions
  );
  assert.equal(env.currentGate, "default");
});

test("combo: reviewer_fixer", () => {
  const env = buildDevLoopHandoffEnvelope(
    prBundle(10, { strategy: INTERNAL_DEV_LOOP_STRATEGY.REVIEWER_FIXER }),
    defaultSettings,
    {},
    defaultOptions
  );
  assert.equal(env.currentGate, "default");
});

test("combo: wait_watch", () => {
  const env = buildDevLoopHandoffEnvelope(
    prBundle(10, { strategy: INTERNAL_DEV_LOOP_STRATEGY.WAIT_WATCH }),
    defaultSettings,
    {},
    defaultOptions
  );
  assert.equal(env.currentGate, "default");
});

// ===========================================================================
// 3. Unknown combo throws
// ===========================================================================

test("unknown-combo: throws for strategy without registered template + bad gate", () => {
  assert.throws(() => {
    lookupAcceptanceTemplate(INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP, "unknown_gate");
  }, /no acceptance template/);
});

// ===========================================================================
// 4. Missing / incomplete inputs → fail closed
// ===========================================================================

test("fail-closed: null resolverOutput throws", () => {
  assert.throws(() => {
    buildDevLoopHandoffEnvelope(null, defaultSettings, {}, defaultOptions);
  }, /resolverOutput is required/);
});

test("fail-closed: undefined resolverOutput throws", () => {
  assert.throws(() => {
    buildDevLoopHandoffEnvelope(undefined, defaultSettings, {}, defaultOptions);
  }, /resolverOutput is required/);
});

test("fail-closed: missing selectedStrategy throws", () => {
  assert.throws(() => {
    buildDevLoopHandoffEnvelope(
      { bundle: { executionMode: "bounded_handoff", nextAction: "x", activeArtifact: { kind: "issue", issue: 1 } } },
      defaultSettings,
      {},
      defaultOptions
    );
  }, /selectedStrategy/);
});

test("needs_reconcile: wrapped and unwrapped canonical results build and validate", () => {
  const envelope = buildDevLoopHandoffEnvelope(nullStrategyBundle(), defaultSettings, {}, defaultOptions);
  assert.equal(envelope.currentGate, "fail_closed_reconcile");
  assert.equal(envelope.routeKind, "needs_reconcile");
  assert.equal(envelope.selectedStrategy, null);
  assert.equal(envelope.worktreeRequired, false);
  assert.ok(envelope.stopRules.includes("reconcile"));
  assert.equal(validateHandoffEnvelope(envelope).ok, true);

  const retrospective = nullStrategyBundle();
  retrospective.bundle.nextAction = "Complete or explicitly skip the required post-run behavioral retrospective before starting or resuming the next dev-loop run.";
  assert.equal(validateHandoffEnvelope(
    buildDevLoopHandoffEnvelope(retrospective, defaultSettings, {}, defaultOptions),
  ).ok, true);

  const resolverOutput = resolveAuthoritativeStartupResumeBundle({
    currentState: {
      target: { kind: "issue", issue: 93 },
      ownership: "copilot",
      nextActor: "user",
      status: "active",
      authorization: "needs_confirmation",
    },
    artifactState: "not_applicable",
    loopState: "active",
  });
  assert.match(resolverOutput.nextAction, /^Stop and reconcile /);
  const unwrapped = buildDevLoopHandoffEnvelope(resolverOutput, defaultSettings, {}, defaultOptions);
  assert.equal(unwrapped.selectedStrategy, null);
  assert.equal(validateHandoffEnvelope(unwrapped).ok, true);
});

test("fail-closed: reconciliation builder rejects incomplete or conflicting tuples", () => {
  const mutations = [
    (input) => { input.bundleKind = "resolved"; },
    (input) => { delete input.bundleKind; },
    (input) => { input.bundle.bundleKind = "resolved"; },
    (input) => { delete input.bundle.bundleKind; },
    (input) => { delete input.selectedStrategy; },
    (input) => { input.selectedStrategy = ""; },
    (input) => { input.selectedStrategy = INTERNAL_DEV_LOOP_STRATEGY.LOCAL_IMPLEMENTATION; },
    (input) => { input.bundle.routeKind = "route"; },
    (input) => { input.bundle.selectedGate = "issue_intake"; },
    (input) => { input.bundle.selectedStrategy = INTERNAL_DEV_LOOP_STRATEGY.ISSUE_INTAKE; },
  ];
  for (const mutate of mutations) {
    const input = nullStrategyBundle();
    mutate(input);
    assert.throws(
      () => buildDevLoopHandoffEnvelope(input, defaultSettings, {}, defaultOptions),
      /needs_reconcile|bundleKind|selectedStrategy/i,
    );
  }

  const routed = issueBundle(42);
  routed.bundleKind = "needs_reconcile";
  assert.throws(
    () => buildDevLoopHandoffEnvelope(routed, defaultSettings, {}, defaultOptions),
    /needs_reconcile|bundleKind/i,
  );
});

test("validate: serialized terminal routing fields require the reconciliation routing invariants", () => {
  const valid = buildDevLoopHandoffEnvelope(
    nullStrategyBundle(), defaultSettings, {}, defaultOptions,
  );
  assert.equal(validateHandoffEnvelope(valid).ok, true);

  const missingTerminalFields = { ...valid };
  delete missingTerminalFields.routeKind;
  delete missingTerminalFields.selectedStrategy;
  const routed = buildDevLoopHandoffEnvelope(
    issueBundle(42), defaultSettings, {}, defaultOptions,
  );
  const invalid = [
    { ...valid, currentGate: "draft" },
    missingTerminalFields,
    { ...routed, routeKind: "route", selectedStrategy: "issue_intake" },
    { ...valid, worktreeRequired: true },
    { ...valid, stopRules: ["merge"] },
    { ...valid, acceptance: { ...valid.acceptance, criteria: [{ id: "scope", must: "Review scope.", severity: "required" }] } },
    { ...valid, nextAction: "   " },
    { ...valid, nextAction: "Continue with the selected strategy." },
  ];
  for (const candidate of invalid) {
    assert.equal(validateHandoffEnvelope(candidate).ok, false);
  }
});

test("fail-closed: missing executionMode throws", () => {
  assert.throws(() => {
    buildDevLoopHandoffEnvelope(
      { bundle: { selectedStrategy: "copilot_pr_followup", nextAction: "x", activeArtifact: { kind: "issue", issue: 1 } } },
      defaultSettings,
      {},
      defaultOptions
    );
  }, /executionMode/);
});

test("fail-closed: missing nextAction throws", () => {
  assert.throws(() => {
    buildDevLoopHandoffEnvelope(
      { bundle: { selectedStrategy: "copilot_pr_followup", executionMode: "bounded_handoff", activeArtifact: { kind: "issue", issue: 1 } } },
      defaultSettings,
      {},
      defaultOptions
    );
  }, /nextAction/);
});

test("fail-closed: missing repo slug throws", () => {
  assert.throws(() => {
    buildDevLoopHandoffEnvelope(
      issueBundle(42),
      defaultSettings,
      {},
      {}
    );
  }, /repo slug/);
});

test("fail-closed: invalid repo slug format throws", () => {
  assert.throws(() => {
    buildDevLoopHandoffEnvelope(
      issueBundle(42),
      defaultSettings,
      {},
      { repoSlug: "not-a-valid-repo" }
    );
  }, /repo slug/);
});

test("fail-closed: missing target kind throws", () => {
  assert.throws(() => {
    buildDevLoopHandoffEnvelope(
      { bundle: { selectedStrategy: "copilot_pr_followup", executionMode: "bounded_handoff", nextAction: "x", activeArtifact: {} } },
      defaultSettings,
      {},
      { repoSlug: "owner/repo" }
    );
  }, /valid target kind/);
});

// ===========================================================================
// 5. Gate state fields
// ===========================================================================

test("gate-state: head SHA, CI status, thread count, round count populate", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    {
      currentHeadSha: "abc123def456",
      ciStatus: "success",
      unresolvedThreadCount: 3,
      copilotRoundCount: 2,
      currentSubGate: "pre-approval",
    },
    defaultOptions
  );

  assert.equal(env.gateState.currentHeadSha, "abc123def456");
  assert.equal(env.gateState.ciStatus, "success");
  assert.equal(env.gateState.unresolvedThreadCount, 3);
  assert.equal(env.gateState.copilotRoundCount, 2);
});

test("gate-state: null/undefined values default to null or 0", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    null,
    defaultOptions
  );

  assert.equal(env.gateState.currentHeadSha, null);
  assert.equal(env.gateState.ciStatus, null);
  assert.equal(env.gateState.unresolvedThreadCount, 0);
  assert.equal(env.gateState.copilotRoundCount, 0);
});

test("gate-state: empty gate state is safe", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    {},
    defaultOptions
  );

  assert.equal(env.gateState.currentHeadSha, null);
  assert.equal(env.gateState.ciStatus, null);
  assert.equal(env.gateState.unresolvedThreadCount, 0);
  assert.equal(env.gateState.copilotRoundCount, 0);
});

// ===========================================================================
// 6. Stop rules derivation
// ===========================================================================

test("stop-rules: derived from settings.autonomy.stopAt", () => {
  const settings = { autonomy: { stopAt: ["refinement", "draft-pr", "pre-approval", "merge"] } };
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    settings,
    {},
    defaultOptions
  );

  assert.deepEqual(env.stopRules, ["refinement", "draft-pr", "pre-approval", "merge"]);
});

test("stop-rules: strategy defaults when settings has no autonomy", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    { workflow: { asyncStartMode: "required", requireDraftFirst: false } },
    {},
    defaultOptions
  );

  assert.deepEqual(env.stopRules, STRATEGY_DEFAULT_STOP_RULES[INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP]);
});

test("stop-rules: local_implementation defaults to empty array", () => {
  const env = buildDevLoopHandoffEnvelope(
    localBranchBundle("feature/x"),
    { workflow: { asyncStartMode: "required", requireDraftFirst: false } },
    {},
    defaultOptions
  );

  assert.deepEqual(env.stopRules, []);
});

test("stop-rules: humanMergeOnly forces 'merge' even when stopAt is []", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    { autonomy: { stopAt: [], humanMergeOnly: true } },
    {},
    defaultOptions
  );

  assert.ok(env.stopRules.includes("merge"), "humanMergeOnly must force 'merge' into derived stopRules");
});

// ===========================================================================
// 7. requiredReads derivation
// ===========================================================================

test("required-reads: populated from resolver output", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42, { requiredReads: ["a.md", "b.md"] }),
    defaultSettings,
    {},
    defaultOptions
  );

  assert.deepEqual(env.requiredReads, ["a.md", "b.md"]);
});
test("required-reads: empty array when resolver has no reads", () => {
  const raw = {
    bundle: {
      selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP,
      executionMode: DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF,
      nextAction: "Do stuff.",
      activeArtifact: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 42 },
    },
  };
  const env = buildDevLoopHandoffEnvelope(raw, defaultSettings, {}, defaultOptions);
  assert.deepEqual(env.requiredReads, []);
});

test("required-reads: reads from resolverOutput top-level when wrapper shape present", () => {
  const raw = {
    requiredReads: ["from-wrapper.md"],
    bundle: {
      selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP,
      executionMode: DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF,
      nextAction: "Do stuff.",
      activeArtifact: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 42 },
      requiredReads: ["from-bundle.md"],
    },
  };
  const env = buildDevLoopHandoffEnvelope(raw, defaultSettings, {}, defaultOptions);
  assert.deepEqual(env.requiredReads, ["from-wrapper.md"]);
});

test("required-reads: falls back to bundle.requiredReads when no top-level reads", () => {
  const raw = {
    bundle: {
      selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP,
      executionMode: DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF,
      nextAction: "Do stuff.",
      activeArtifact: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 42 },
      requiredReads: ["from-bundle.md"],
    },
  };
  const env = buildDevLoopHandoffEnvelope(raw, defaultSettings, {}, defaultOptions);
  assert.deepEqual(env.requiredReads, ["from-bundle.md"]);
});


// ===========================================================================
// 8. PR target
// ===========================================================================

test("target: PR target with issue reference", () => {
  const env = buildDevLoopHandoffEnvelope(
    prBundle(100, { issue: 42 }),
    defaultSettings,
    {},
    defaultOptions
  );

  assert.equal(env.target.kind, "pr");
  assert.equal(env.target.pr, 100);
  assert.equal(env.target.issue, 42);
  assert.equal(env.target.repo, "owner/repo");
});

// ===========================================================================
// 9. maxCopilotRounds derivation
// ===========================================================================

test("maxCopilotRounds: from settings.refinement.maxCopilotRounds", () => {
  const settings = {
    ...defaultSettings,
    refinement: { maxCopilotRounds: 10 },
  };
  const env = buildDevLoopHandoffEnvelope(issueBundle(42), settings, {}, defaultOptions);

  assert.equal(env.maxCopilotRounds, 10);
});

test("maxCopilotRounds: defaults to 5", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    { workflow: { asyncStartMode: "required", requireDraftFirst: false } },
    {},
    defaultOptions
  );
  assert.equal(env.maxCopilotRounds, 5);
});

// ===========================================================================
// 10. Overrides
// ===========================================================================

test("overrides: user overrides populate when provided", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    {},
    { ...defaultOptions, overrides: { mergeAuthorized: false, scopeConstraint: "only docs" } }
  );

  assert.equal(env.overrides.mergeAuthorized, false);
  assert.equal(env.overrides.scopeConstraint, "only docs");
});

test("overrides: absent when not provided", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    {},
    defaultOptions
  );

  assert.equal(env.overrides, undefined);
});

test("overrides: absent when empty object", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    {},
    { ...defaultOptions, overrides: {} }
  );

  assert.equal(env.overrides, undefined);
});

// ===========================================================================
// 11. Gate config derivation
// ===========================================================================

test("gate-config: draft gate config from settings", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    {},
    defaultOptions
  );

  assert.ok(env.gateConfig);
  assert.deepEqual(env.gateConfig.angles, ["scope", "coverage", "correctness"]);
  assert.equal(env.gateConfig.requireCi, true);
  assert.deepEqual(env.gateConfig.blockCleanOnFindingSeverities, ["high"]);
});

test("gate-config: pre-approval gate config from settings", () => {
  const settings = {
    ...defaultSettings,
    gates: {
      draft: { angles: ["scope"], requireCi: true, blockCleanOnFindingSeverities: ["high"] },
      // Legacy spelling as input (backward compat): still resolves the angles correctly.
      preApproval: { angles: ["dry", "kiss"], requireCi: true, blockCleanOnFindingSeverities: ["must-fix", "worth-fixing-now"] },
    },
  };
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    settings,
    { currentSubGate: "pre-approval" },
    defaultOptions
  );

  assert.ok(env.gateConfig);
  assert.deepEqual(env.gateConfig.angles, ["dry", "kiss"]);
});

test("gate-config: excludes filtered angles", () => {
  const settings = {
    ...defaultSettings,
    gates: {
      draft: {
        angles: ["scope", "coverage", { name: "deep", enabled: false }],
        requireCi: true,
        blockCleanOnFindingSeverities: ["high"],
      },
    },
  };
  const env = buildDevLoopHandoffEnvelope(issueBundle(42), settings, {}, defaultOptions);

  assert.deepEqual(env.gateConfig.angles, ["scope", "coverage"]);
});

// ===========================================================================
// 12. Worktree / cwd derivation
// ===========================================================================

test("cwd: explicit worktreeCwd wins", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    {},
    { ...defaultOptions, worktreeCwd: "/explicit/path" }
  );

  assert.equal(env.cwd, "/explicit/path");
});

test("cwd: derived from repoRoot + issue slug", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    {},
    { ...defaultOptions, repoRoot: "/home/user/repo" }
  );

  assert.equal(env.cwd, "/home/user/repo/tmp/worktrees/dev-loops/issue-42");
});

test("cwd: real tracker-local routing retains sanctioned issue acquisition identity", () => {
  for (const issue of [2335, 2508]) {
    const bundle = resolveAuthoritativeStartupResumeBundle({
      targetPreference: "prefer_local",
      currentState: {
        target: { kind: "issue", issue }, ownership: "copilot", nextActor: "copilot",
        status: "active", authorization: "needs_confirmation",
      },
      issueLinkageResolution: "resolved_no_open_pr", issueReadiness: "ready",
      issueAssignmentState: "assigned_to_copilot", artifactState: "not_applicable", loopState: "awaiting_triage",
    });
    assert.equal(bundle.bundleKind, "resolved");
    assert.equal(bundle.selectedStrategy, "local_implementation");
    assert.equal(bundle.activeArtifact.kind, "local_phase");
    assert.equal(bundle.activeArtifact.phase, `issue-${issue}`);
    const envelope = buildDevLoopHandoffEnvelope(bundle, defaultSettings, {}, { ...defaultOptions, repoRoot: "/repo" });
    assert.equal(envelope.cwd, resolveWorktreePath({ repoRoot: "/repo", kind: "issue", number: issue }));
    assert.equal(envelope.target.kind, "local_phase");
    assert.equal(envelope.target.phase, bundle.activeArtifact.phase);
  }
});

test("cwd: explicit phases and branches keep their own identity", () => {
  for (const [input, suffix] of [
    [localPhaseBundle("issue-2335", { issue: 2335 }), "phase-2335-issue-2335"],
    [localPhaseBundle("custom", { issue: 2335 }), "phase-2335-custom"],
    [localBranchBundle("feature/local", { issue: 2335 }), "feature-local"],
    [prBundle(99), "pr-99"],
  ]) {
    input.bundle.issueLinkageResolution = "not_applicable";
    assert.equal(deriveCwd(input.bundle, { repoRoot: "/repo" }), `/repo/tmp/worktrees/dev-loops/${suffix}`);
  }
});

test("cwd: null when no repoRoot or explicit cwd", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    {},
    defaultOptions
  );

  assert.equal(env.cwd, null);
});

// issue 2532: startup run INSIDE the target's own worktree reports that worktree as
// its repo root; the envelope must name that root, never a worktree nested inside it.
test("cwd: startup inside the target's own worktree names that root, not a nested namespace", () => {
  const worktreeRoot = "/repo/tmp/worktrees/dev-loops/issue-42";
  for (const [input, expected] of [
    [issueBundle(42), worktreeRoot],
    [prBundle(42), "/repo/tmp/worktrees/dev-loops/pr-42"],
  ]) {
    assert.equal(deriveCwd(input.bundle, { repoRoot: expected }), expected);
    assert.ok(!deriveCwd(input.bundle, { repoRoot: expected }).includes(`${expected}/tmp/worktrees`));
  }
  // An issue-named checkout serving its PR is NOT the PR's own root, so the derivation still
  // appends the PR namespace. Most routes never consume that path: the CLI builder binds
  // `worktreeCwd` from the live PR checkout instead. Pinned here so the boundary stays explicit.
  assert.equal(deriveCwd(prBundle(42).bundle, { repoRoot: worktreeRoot }), `${worktreeRoot}/tmp/worktrees/dev-loops/pr-42`);
  // A trailing separator is the same root, not a new one.
  assert.equal(deriveCwd(issueBundle(42).bundle, { repoRoot: `${worktreeRoot}/` }), worktreeRoot);
  // A repo root that only LOOKS related still gets its own worktree.
  assert.equal(deriveCwd(issueBundle(42).bundle, { repoRoot: "/repo/tmp/worktrees/dev-loops/issue-4" }), "/repo/tmp/worktrees/dev-loops/issue-4/tmp/worktrees/dev-loops/issue-42");
});

// issue 2532: the slug fallback serves local_branch/local_phase units, whose own namespaced
// checkout hits the same nested-namespace trap as issue-<n>/pr-<n>. And one logical repo root
// must have exactly one spelling, or the field cannot exact-match the real worktree.
test("cwd: a slug checkout is its own root, and one logical root keeps one spelling", () => {
  for (const [input, ownRoot] of [
    [localBranchBundle("feature/local", { issue: 2335 }), "/repo/tmp/worktrees/dev-loops/feature-local"],
    [localPhaseBundle("custom", { issue: 2335 }), "/repo/tmp/worktrees/dev-loops/phase-2335-custom"],
  ]) {
    assert.equal(deriveCwd(input.bundle, { repoRoot: ownRoot }), ownRoot, input.bundle.activeArtifact.kind);
    assert.ok(!deriveCwd(input.bundle, { repoRoot: ownRoot }).includes(`${ownRoot}/tmp/worktrees`));
  }
  // Backslash-separated roots normalize to one spelling instead of falling through the suffix test.
  assert.equal(
    deriveCwd(issueBundle(42).bundle, { repoRoot: "C:\\repo\\tmp\\worktrees\\dev-loops\\issue-42" }),
    "C:/repo/tmp/worktrees/dev-loops/issue-42"
  );
  // A trailing separator, a doubled separator and a `.` segment are the same root, so they
  // neither append a second namespace nor emit a `//`-joined path.
  for (const oddRoot of ["/repo/", "/repo//", "/repo/.", "/repo//./"]) {
    assert.equal(deriveCwd(issueBundle(42).bundle, { repoRoot: oddRoot }), "/repo/tmp/worktrees/dev-loops/issue-42", oddRoot);
  }
  assert.equal(deriveCwd(issueBundle(42).bundle, { repoRoot: "/repo//tmp/worktrees/dev-loops/issue-42" }), "/repo/tmp/worktrees/dev-loops/issue-42");
  assert.equal(deriveCwd(issueBundle(42).bundle, { repoRoot: "/repo/tmp/worktrees/dev-loops/issue-42/./" }), "/repo/tmp/worktrees/dev-loops/issue-42");
  assert.equal(deriveCwd(prBundle(42).bundle, { repoRoot: "/repo//tmp/worktrees/dev-loops/pr-42" }), "/repo/tmp/worktrees/dev-loops/pr-42");
});

// issue 2532: the root's SHAPE picks the normalizer. A drive root and a UNC share root keep
// Windows semantics; `posix.normalize` alone folds a share's significant leading `//` into a
// root-relative POSIX path, and the suffix logic cannot repair it afterwards.
test("cwd: Windows drive and UNC roots keep their shape, and a share prefix never collapses", () => {
  const accepted = [
    // repoRoot 'C:/repo' (drive-letter absolute)
    ["C:/repo", "C:/repo/tmp/worktrees/dev-loops/issue-42"],
    // repoRoot '//fileserver/git/dev-loops' (POSIX UNC prefix)
    ["//fileserver/git/dev-loops", "//fileserver/git/dev-loops/tmp/worktrees/dev-loops/issue-42"],
    // repoRoot 'C:/repo/' (trailing separator)
    ["C:/repo/", "C:/repo/tmp/worktrees/dev-loops/issue-42"],
    // repoRoot in the backslash-separated UNC form identifying a server and share
    ["\\\\fileserver\\git\\dev-loops", "//fileserver/git/dev-loops/tmp/worktrees/dev-loops/issue-42"],
  ];
  for (const [repoRoot, expected] of accepted) {
    assert.equal(deriveCwd(issueBundle(42).bundle, { repoRoot }), expected, repoRoot);
  }
  // Rejected: the share root rewritten to a root-relative POSIX path names no real worktree.
  assert.notEqual(
    deriveCwd(issueBundle(42).bundle, { repoRoot: "//fileserver/git/dev-loops" }),
    "/fileserver/git/dev-loops/tmp/worktrees/dev-loops/issue-42"
  );
  // Rejected: a doubled separator between the root and the namespace.
  assert.notEqual(
    deriveCwd(issueBundle(42).bundle, { repoRoot: "/repo//" }),
    "/repo//tmp/worktrees/dev-loops/issue-42"
  );
});

// issue 2532: a separator-only root and a drive root are the two roots whose only content IS
// the separator that makes them absolute. Interpolating `${root}/...` doubled it for `/` and
// dropped it for `C:/`, so both joins (the resolveWorktreePath one and the slug fallback) go
// through the path library for the root's shape.
test("cwd: a separator-only root never doubles its separator and a drive root keeps it", () => {
  const rootOnly = deriveCwd(issueBundle(42).bundle, { repoRoot: "/" });
  assert.equal(rootOnly, "/tmp/worktrees/dev-loops/issue-42");
  assert.ok(!rootOnly.startsWith("//"), "a separator-only root must not emit a doubled separator");
  // The slug fallback joins the same way, so the second interpolation cannot double either.
  assert.equal(
    deriveCwd(localBranchBundle("feature/local", { issue: 2335 }).bundle, { repoRoot: "/" }),
    "/tmp/worktrees/dev-loops/feature-local"
  );
  // A bare drive (`C:`) is drive-relative, so the drive-root form must survive as `C:/`.
  assert.equal(deriveCwd(issueBundle(42).bundle, { repoRoot: "/repo", worktreeCwd: "C:/" }), "C:/");
});

// issue 2532: the sibling `worktreeCwd` channel is canonicalized too, so one logical repo root
// yields one `cwd` byte sequence whichever input option named it.
test("cwd: worktreeCwd is canonicalized to the same single spelling", () => {
  const root = "/repo/tmp/worktrees/dev-loops/issue-42";
  for (const worktreeCwd of [`${root}/`, "/repo//tmp/worktrees/dev-loops/issue-42", root]) {
    assert.equal(deriveCwd(issueBundle(42).bundle, { repoRoot: "/repo", worktreeCwd }), root, worktreeCwd);
  }
});

// ===========================================================================
// 13. Unit coordinator hand-back boundaries (issue 2532)
// ===========================================================================

test("unitBoundaries: a unit without a PR hands back at the draft PR and after the gate verdict", () => {
  const env = buildDevLoopHandoffEnvelope(issueBundle(42), defaultSettings, {}, defaultOptions);
  assert.deepEqual(env.unitBoundaries, {
    handBackAfter: [UNIT_BOUNDARY.DRAFT_PR_OPENED, UNIT_BOUNDARY.GATE_VERDICT_POSTED],
    resume: { kind: "loop_startup", issue: 42, pr: null, branch: null, phase: null },
  });
});

test("unitBoundaries: a PR unit hands back only after the gate verdict", () => {
  const env = buildDevLoopHandoffEnvelope(prBundle(99), defaultSettings, {}, defaultOptions);
  assert.deepEqual(env.unitBoundaries, {
    handBackAfter: [UNIT_BOUNDARY.GATE_VERDICT_POSTED],
    resume: { kind: "loop_startup", issue: null, pr: 99, branch: null, phase: null },
  });
});

test("unitBoundaries: both gate verdict boundaries carry the same hand-back and resume target", () => {
  // Draft and pre-approval rounds are separate units; each resumes from the same
  // authoritative PR target, so neither reads the other's conversation.
  // "Verdict evidence" is the reviewed head plus the CI status, not only the counts: a producer
  // regression that drops either from the recovered state must fail at BOTH boundaries.
  for (const [gateState, currentGate] of [
    [{ copilotRoundCount: 0, currentSubGate: "draft", currentHeadSha: "a".repeat(40), ciStatus: "success" }, "draft"],
    [{
      copilotRoundCount: 3, unresolvedThreadCount: 2, currentSubGate: "pre-approval",
      currentHeadSha: "b".repeat(40), ciStatus: "pending",
    }, "pre-approval"],
  ]) {
    const env = buildDevLoopHandoffEnvelope(prBundle(99), defaultSettings, gateState, defaultOptions);
    assert.equal(env.currentGate, currentGate);
    assert.deepEqual(env.unitBoundaries.handBackAfter, [UNIT_BOUNDARY.GATE_VERDICT_POSTED]);
    assert.deepEqual(env.unitBoundaries.resume, { kind: "loop_startup", issue: null, pr: 99, branch: null, phase: null });
    assert.equal(env.gateState.copilotRoundCount, gateState.copilotRoundCount ?? 0);
    assert.equal(env.gateState.unresolvedThreadCount, gateState.unresolvedThreadCount ?? 0);
    assert.equal(env.gateState.currentHeadSha, gateState.currentHeadSha, `${currentGate} boundary keeps the reviewed head`);
    assert.equal(env.gateState.ciStatus, gateState.ciStatus, `${currentGate} boundary keeps the CI status`);
  }
});

test("unitBoundaries: absent where the route has no unit to hand back", () => {
  const reconcile = {
    bundleKind: "needs_reconcile",
    selectedStrategy: "none",
    bundle: {
      bundleKind: "needs_reconcile", selectedStrategy: null, routeKind: "needs_reconcile",
      selectedGate: "fail_closed_reconcile", loopState: "unknown",
      executionMode: DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF,
      nextAction: "Reconcile before routing.", requiredReads: [],
      activeArtifact: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 42 },
    },
  };
  assert.equal(buildDevLoopHandoffEnvelope(reconcile, defaultSettings, {}, defaultOptions).unitBoundaries, undefined);
  // A read-only round and a wait route own no phase, so the field never contradicts their stop rules.
  for (const strategy of [INTERNAL_DEV_LOOP_STRATEGY.REVIEW, INTERNAL_DEV_LOOP_STRATEGY.UI_REVIEW, INTERNAL_DEV_LOOP_STRATEGY.WAIT_WATCH]) {
    const env = buildDevLoopHandoffEnvelope(prBundle(99, { strategy }), defaultSettings, {}, defaultOptions);
    assert.equal(env.unitBoundaries, undefined, `${strategy} has no unit boundary`);
  }
});

test("unitBoundaries: the local-kind `linkedPr` guard opens no draft PR for a hand-written local bundle", () => {
  // GUARD-LEVEL CASE, not producer reachability. `deriveTarget`'s `linkedPr` forwarding
  // for the local kinds is the DEFENDED EXTENSION POINT: no shipped producer emits `linkedPr`
  // on a local target today (`buildStatusArtifactIdentity` copies only
  // kind/issue/pr/branch/phase, and the router's `prefer_local` target hardcodes
  // `linkedPr: null`), so this fixture supplies a shape only a test can create. It exists so
  // that IF a producer starts emitting a local linked PR, the ownership rule already holds.
  // The routed boundary a local unit actually receives today is pinned by the next test.
  for (const input of [
    localBranchBundle("feature/local", { issue: 2335, linkedPr: 77 }),
    localPhaseBundle("tmp/plan.md", { linkedPr: 77 }),
  ]) {
    const env = buildDevLoopHandoffEnvelope(input, defaultSettings, {}, defaultOptions);
    assert.deepEqual(env.unitBoundaries.handBackAfter, [UNIT_BOUNDARY.GATE_VERDICT_POSTED], `${input.bundle.activeArtifact.kind} with a PR`);
  }
});

test("unitBoundaries: a routed local target receives the draft-PR boundary from the real producer", () => {
  // PRODUCER REACHABILITY. The route and its identities come from the authoritative resolver,
  // so this pins what a local unit is actually emitted at the head: the `prefer_local` target
  // the router builds carries `linkedPr: null`, so a routed local phase owns no PR and stops
  // at the draft PR before the gate verdict. If the forwarding the test above guards vanished,
  // this case would stay green — which is why both exist, one per axis.
  const bundle = resolveAuthoritativeStartupResumeBundle({
    targetPreference: "prefer_local",
    currentState: {
      target: { kind: "issue", issue: 2335, pr: null, linkedPr: null, branch: null, phase: null },
      ownership: "local", nextActor: "local",
      status: "active", authorization: "authorized",
    },
    issueLinkageResolution: "resolved_no_open_pr", issueReadiness: "ready",
    issueAssignmentState: "not_applicable", artifactState: "not_applicable", loopState: "idle",
  });
  assert.equal(bundle.bundleKind, "resolved", bundle.reason);
  assert.equal(bundle.activeArtifact.kind, DEV_LOOP_TARGET_KIND.LOCAL_PHASE, "the routed local target is a phase unit");
  assert.equal(bundle.activeArtifact.linkedPr, undefined, "the producer emits no local linked PR");
  const env = buildDevLoopHandoffEnvelope(bundle, defaultSettings, {}, defaultOptions);
  assert.deepEqual(env.unitBoundaries.handBackAfter, [UNIT_BOUNDARY.DRAFT_PR_OPENED, UNIT_BOUNDARY.GATE_VERDICT_POSTED]);
  assert.deepEqual(env.unitBoundaries.resume, {
    kind: "loop_startup", issue: 2335, pr: null, branch: null, phase: "issue-2335",
  });
});

test("unitBoundaries: an issue target carrying a bound PR is never a routed shape", () => {
  // PR ownership on an issue target arrives as `linkedPr` (see the two fixtures above), never
  // as `pr`: the route refuses an issue target that carries `pr` and re-targets an issue with a
  // linked PR to the PR kind, so the envelope derives ownership without a `target.pr` arm. This
  // pins that producer boundary, so re-adding a `target.pr` arm needs new evidence, not a guess.
  const bundle = resolveAuthoritativeStartupResumeBundle({
    currentState: {
      target: { kind: "issue", issue: 2483, pr: 2900, linkedPr: null, branch: null, phase: null },
      ownership: "copilot", nextActor: "copilot",
      status: "active", authorization: "needs_confirmation",
    },
    issueLinkageResolution: "no_pr", issueReadiness: "ready",
    issueAssignmentState: "assigned_to_copilot", artifactState: "open", loopState: "awaiting_triage",
  });
  assert.equal(bundle.bundleKind, "needs_reconcile", bundle.reason);
});

test("unitBoundaries: an issue with a linked PR routes to the PR unit, never a draft-PR local unit", () => {
  // Nothing here hand-writes the envelope's ownership: the route and its identities come from
  // the authoritative resolver, so the assertion pins the PRODUCER. An issue whose linked PR
  // resolves re-targets to the PR route before gate selection, so the `prefer_local` local-phase
  // branch is unreachable for it and no unit is told to open a draft PR it already has.
  const bundle = resolveAuthoritativeStartupResumeBundle({
    targetPreference: "prefer_local",
    currentState: {
      target: { kind: "issue", issue: 2335, pr: null, linkedPr: 77, branch: null, phase: null },
      ownership: "copilot", nextActor: "copilot",
      status: "active", authorization: "needs_confirmation",
    },
    issueLinkageResolution: "resolved_linked_pr", issueReadiness: "ready",
    issueAssignmentState: "assigned_to_copilot", artifactState: "open", loopState: "awaiting_triage",
  });
  assert.equal(bundle.bundleKind, "resolved", bundle.reason);
  assert.equal(bundle.activeArtifact.kind, "pr", "the linked PR stays the canonical artifact");
  assert.equal(bundle.activeArtifact.pr, 77);
  assert.equal(bundle.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP);
  const env = buildDevLoopHandoffEnvelope(bundle, defaultSettings, {}, defaultOptions);
  // Owning the PR drops the draft-PR boundary and resumes on the PR identity it already has.
  assert.deepEqual(env.unitBoundaries.handBackAfter, [UNIT_BOUNDARY.GATE_VERDICT_POSTED]);
  assert.deepEqual(env.unitBoundaries.resume, { kind: "loop_startup", issue: 2335, pr: 77, branch: null, phase: null });
});

test("unitBoundaries: a branch-only unit resumes by branch and validates on that identity alone", () => {
  // The closest existing fixture also carries an `issue`, so a dropped branch identity would
  // still validate: pin the branch-only identity through the validator itself.
  const env = buildDevLoopHandoffEnvelope(localBranchBundle("feature/local"), defaultSettings, {}, defaultOptions);
  assert.deepEqual(env.unitBoundaries.resume, {
    kind: "loop_startup", issue: null, pr: null, branch: "feature/local", phase: null,
  });
  const resume = env.unitBoundaries.resume;
  assert.equal(validateHandoffEnvelope({ ...env, unitBoundaries: { ...env.unitBoundaries, resume } }).ok, true);
  assert.equal(
    validateHandoffEnvelope({ ...env, unitBoundaries: { ...env.unitBoundaries, resume: { ...resume, branch: null } } }).ok,
    false
  );
});

test("unitBoundaries: validator rejects a non-object field, a reversed order and a malformed identity", () => {
  const base = buildDevLoopHandoffEnvelope(issueBundle(42), defaultSettings, {}, defaultOptions);
  const withBoundaries = (unitBoundaries) => validateHandoffEnvelope({ ...base, unitBoundaries });

  // Accepted form: both boundaries in canonical (declaration) order.
  assert.equal(withBoundaries({
    handBackAfter: [UNIT_BOUNDARY.DRAFT_PR_OPENED, UNIT_BOUNDARY.GATE_VERDICT_POSTED],
    resume: { kind: "loop_startup", issue: 42, pr: null },
  }).ok, true);
  // Rejected: the field is present but not an object at all.
  assert.equal(withBoundaries([]).ok, false);
  assert.equal(withBoundaries("x").ok, false);
  // Rejected: the documented ordered/first-match list, reversed.
  assert.equal(withBoundaries({
    handBackAfter: [UNIT_BOUNDARY.GATE_VERDICT_POSTED, UNIT_BOUNDARY.DRAFT_PR_OPENED],
    resume: { kind: "loop_startup", issue: 42, pr: null },
  }).ok, false);
  // Rejected: a present-but-invalid issue, even though a phase identity is also present —
  // the builder only ever emits a positive integer or null.
  assert.equal(withBoundaries({
    handBackAfter: [UNIT_BOUNDARY.GATE_VERDICT_POSTED],
    resume: { kind: "loop_startup", issue: "42", pr: null, phase: "x" },
  }).ok, false);
  assert.equal(withBoundaries({
    handBackAfter: [UNIT_BOUNDARY.GATE_VERDICT_POSTED],
    resume: { kind: "loop_startup", issue: -5, pr: null, phase: "x" },
  }).ok, false);
  // Accepted: a valid issue plus a phase identity.
  assert.equal(withBoundaries({
    handBackAfter: [UNIT_BOUNDARY.GATE_VERDICT_POSTED],
    resume: { kind: "loop_startup", issue: 42, pr: null, phase: "x" },
  }).ok, true);
});

test("unitBoundaries: a phase-only unit resumes by phase", () => {
  // Plan-file/spike/lightweight phases carry no issue, PR or branch: the phase label is the
  // identity, and the builder must not emit an envelope its own validator refuses. Byte stability
  // is owned once, for the whole prefix, by the #1462 test below; it is not re-tested here.
  const planFile = localPhaseBundle("tmp/plan.md", { strategy: INTERNAL_DEV_LOOP_STRATEGY.LOCAL_IMPLEMENTATION });
  planFile.bundle.activeArtifact.issue = null;
  const env = buildDevLoopHandoffEnvelope(planFile, defaultSettings, {}, defaultOptions);
  assert.deepEqual(env.unitBoundaries.resume, { kind: "loop_startup", issue: null, pr: null, branch: null, phase: "tmp/plan.md" });
  assert.equal(validateHandoffEnvelope(env).ok, true);
});

test("unitBoundaries: resume identity validation covers every accepted and rejected form", () => {
  // The producer only ever emits `issue`/`pr` as a positive integer or null and
  // `branch`/`phase` as a non-empty string or null, so the validator must reject every
  // malformed form — including a bad branch/phase riding alongside a valid issue.
  const base = buildDevLoopHandoffEnvelope(issueBundle(42), defaultSettings, {}, defaultOptions);
  const accepts = (resume) => validateHandoffEnvelope({
    ...base,
    unitBoundaries: { handBackAfter: [UNIT_BOUNDARY.GATE_VERDICT_POSTED], resume },
  }).ok;
  const forms = [
    [{ kind: "loop_startup", issue: 42, pr: null, branch: "feature/x", phase: null }, true],
    [{ kind: "loop_startup", issue: null, pr: null, branch: null, phase: "tmp/plan.md" }, true],
    [{ kind: "loop_startup", issue: null, pr: 99, branch: null, phase: null }, true],
    [{ kind: "loop_startup", issue: 42, pr: null, branch: 99 }, false],
    [{ kind: "loop_startup", issue: 42, pr: null, branch: null, phase: 42 }, false],
    // `pr` gets its own rejected form carrying a VALID issue: routing every count check
    // through `issue` alone would leave the `pr` half of the integer clause unexercised, and
    // a row with no other identity would be rejected by the no-identity catch-all anyway.
    [{ kind: "loop_startup", issue: 42, pr: "99", branch: null, phase: null }, false],
    // And a whitespace-only text identity is not an identity: this is the `.trim()` half of the
    // text clause, which a non-string form cannot reach.
    [{ kind: "loop_startup", issue: 42, pr: null, branch: "   ", phase: null }, false],
    // The `!resume || typeof resume !== "object"` half of the guard. Without these two rows the
    // arm is reached only through the `kind !== "loop_startup"` mismatch, so a regression that
    // dereferences `resume.kind` before the guard would throw a TypeError instead of returning
    // the documented `{ ok: false }` and every suite would stay green.
    [null, false],
    ["x", false],
  ];
  for (const [resume, expected] of forms) assert.equal(accepts(resume), expected, JSON.stringify(resume));
});

test("unitBoundaries: validator rejects a foreign boundary name or a resume with no target", () => {
  const base = buildDevLoopHandoffEnvelope(issueBundle(42), defaultSettings, {}, defaultOptions);
  const withBoundaries = (unitBoundaries) => validateHandoffEnvelope({ ...base, unitBoundaries });

  assert.equal(withBoundaries(base.unitBoundaries).ok, true);
  assert.equal(withBoundaries({ handBackAfter: ["merged"], resume: { kind: "loop_startup", issue: 42, pr: null } }).ok, false);
  assert.equal(withBoundaries({ handBackAfter: [], resume: { kind: "loop_startup", issue: 42, pr: null } }).ok, false);
  assert.equal(withBoundaries({ handBackAfter: [UNIT_BOUNDARY.GATE_VERDICT_POSTED, UNIT_BOUNDARY.GATE_VERDICT_POSTED], resume: { kind: "loop_startup", issue: 42, pr: null } }).ok, false);
  assert.equal(withBoundaries({ handBackAfter: [UNIT_BOUNDARY.GATE_VERDICT_POSTED], resume: { kind: "loop_startup", issue: null, pr: null } }).ok, false);
  assert.equal(withBoundaries({ handBackAfter: [UNIT_BOUNDARY.GATE_VERDICT_POSTED], resume: { kind: "webhook", issue: 42, pr: null } }).ok, false);
});

// ===========================================================================
// 14. Backward compat — acceptance shape maps to subagent contract
// ===========================================================================

test("backward-compat: acceptance shape has criteria with id+must+severity", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    {},
    defaultOptions
  );

  for (const c of env.acceptance.criteria) {
    assert.equal(typeof c.id, "string");
    assert.ok(c.id.length > 0);
    assert.equal(typeof c.must, "string");
    assert.ok(c.must.length > 0);
    assert.equal(typeof c.severity, "string");
    assert.ok(["required", "recommended"].includes(c.severity));
  }
});

test("determinism: injectable now makes derivedAt stable", () => {
  const frozen = "2026-01-01T00:00:00.000Z";
  const e1 = buildDevLoopHandoffEnvelope(issueBundle(99), defaultSettings, {}, defaultOptions, new Date(frozen));
  const e2 = buildDevLoopHandoffEnvelope(issueBundle(99), defaultSettings, {}, defaultOptions, new Date(frozen));
  assert.strictEqual(e1.gateState.derivedAt, frozen);
  assert.strictEqual(e2.gateState.derivedAt, frozen);
  assert.strictEqual(e1.gateState.derivedAt, e2.gateState.derivedAt);
});

test("determinism: derivedAt defaults to current time when now not provided", () => {
  const before = new Date().toISOString();
  const e = buildDevLoopHandoffEnvelope(issueBundle(99), defaultSettings, {}, defaultOptions);
  assert.ok(e.gateState.derivedAt >= before);
});

// #1462: the whole point — everything ABOVE gateState must be byte-identical
// across builds where only the volatile gate-state (or the timestamp) differs, so
// a fresh reviewer spawn cache-READS the stable prefix instead of re-billing it.
test("#1462: the envelope minus gateState is byte-stable across differing gate-state / timestamps", () => {
  const frozen1 = "2026-01-01T00:00:00.000Z";
  const frozen2 = "2026-02-02T00:00:00.000Z";
  const a = buildDevLoopHandoffEnvelope(issueBundle(7), defaultSettings, { currentHeadSha: "aaa", ciStatus: "success", unresolvedThreadCount: 0, copilotRoundCount: 1 }, defaultOptions, new Date(frozen1));
  const b = buildDevLoopHandoffEnvelope(issueBundle(7), defaultSettings, { currentHeadSha: "bbb", ciStatus: "pending", unresolvedThreadCount: 4, copilotRoundCount: 3 }, defaultOptions, new Date(frozen2));
  const stable = (env) => { const { gateState, ...rest } = env; return JSON.stringify(rest); };
  assert.strictEqual(stable(a), stable(b), "stable prefix must be byte-identical when only gateState/timestamp changes");
  assert.notStrictEqual(JSON.stringify(a.gateState), JSON.stringify(b.gateState), "gateState is the only part that varies");
  // gateState MUST be the last key — appending any field after it would move
  // volatile-adjacent content out of the tail and re-poison the cacheable prefix
  const keys = Object.keys(a);
  assert.strictEqual(keys[keys.length - 1], "gateState", "gateState must be positioned last in the envelope");
});

test("backward-compat: envelope is frozen (top-level)", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    {},
    defaultOptions
  );

  assert.throws(() => { env.acceptance = null; }, /Cannot assign to read only property|Attempted to assign to readonly property/);
  assert.throws(() => { env.stopRules = []; }, /Cannot assign to read only property|Attempted to assign to readonly property/);
});

// ===========================================================================
// 14. Edge cases
// ===========================================================================

test("edge: branch target includes issue", () => {
  const env = buildDevLoopHandoffEnvelope(
    localBranchBundle("feature/x", { issue: 42 }),
    defaultSettings,
    {},
    defaultOptions
  );

  assert.equal(env.target.kind, "local_branch");
  assert.equal(env.target.branch, "feature/x");
  assert.equal(env.target.issue, 42);
});

test("edge: phase target with issue", () => {
  const env = buildDevLoopHandoffEnvelope(
    localPhaseBundle("10", { issue: 536 }),
    defaultSettings,
    {},
    defaultOptions
  );

  assert.equal(env.target.kind, "local_phase");
  assert.equal(env.target.phase, "10");
  assert.equal(env.target.issue, 536);
});

test("edge: neg copilotRoundCount clamps to 0", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    { copilotRoundCount: -1 },
    defaultOptions
  );

  assert.equal(env.gateState.copilotRoundCount, 0);
});

// ===========================================================================
// 15. Unit: normalizeGateState
// ===========================================================================

test("unit: normalizeGateState handles all fields", () => {
  const gs = normalizeGateState({
    currentHeadSha: "sha123",
    ciStatus: "pending",
    unresolvedThreadCount: 5,
    copilotRoundCount: 3,
    currentSubGate: "draft",
  });

  assert.equal(gs.currentHeadSha, "sha123");
  assert.equal(gs.ciStatus, "pending");
  assert.equal(gs.unresolvedThreadCount, 5);
  assert.equal(gs.copilotRoundCount, 3);
  assert.equal(gs.currentSubGate, "draft");
});

test("unit: normalizeGateState with null falls back safely", () => {
  const gs = normalizeGateState(null);
  assert.equal(gs.currentHeadSha, null);
  assert.equal(gs.ciStatus, null);
  assert.equal(gs.unresolvedThreadCount, 0);
  assert.equal(gs.copilotRoundCount, 0);
  assert.equal(gs.currentSubGate, undefined);
});

// ===========================================================================
// 16. Unit: acceptanceKey
// ===========================================================================

test("unit: acceptanceKey format", () => {
  assert.equal(acceptanceKey("copilot_pr_followup", "draft"), "copilot_pr_followup::draft");
});

// ===========================================================================
// 17. Unit: buildWorktreeSlug
// ===========================================================================

test("unit: buildWorktreeSlug for issue", () => {
  assert.equal(
    buildWorktreeSlug({ issue: 42 }, DEV_LOOP_TARGET_KIND.ISSUE),
    "issue-42"
  );
});

test("unit: buildWorktreeSlug for PR", () => {
  assert.equal(
    buildWorktreeSlug({ pr: 100 }, DEV_LOOP_TARGET_KIND.PR),
    "pr-100"
  );
});

test("unit: buildWorktreeSlug for branch", () => {
  assert.equal(
    buildWorktreeSlug({ branch: "feature/x" }, DEV_LOOP_TARGET_KIND.LOCAL_BRANCH),
    "feature-x"
  );
});

test("unit: flattenSlugSegment replaces path separators", () => {
  assert.strictEqual(flattenSlugSegment("feature/x"), "feature-x");
  assert.strictEqual(flattenSlugSegment("a" + String.fromCharCode(92) + "b"), "a-b");
  assert.strictEqual(flattenSlugSegment("simple"), "simple");
  assert.strictEqual(flattenSlugSegment(""), "");
  assert.strictEqual(flattenSlugSegment(null), "");
});

// ===========================================================================
// 18. Verify all ACCEPTANCE_TEMPLATES combos registered
// ===========================================================================

test("templates: all copilot_pr_followup sub-gates registered", () => {
  for (const sub of ["draft", "watch", "pre-approval"]) {
    assert.ok(
      ACCEPTANCE_TEMPLATES.has(acceptanceKey(INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP, sub)),
      `missing template for copilot_pr_followup::${sub}`
    );
  }
});

test("templates: final_approval registered", () => {
  assert.ok(ACCEPTANCE_TEMPLATES.has(acceptanceKey(INTERNAL_DEV_LOOP_STRATEGY.FINAL_APPROVAL, "default")));
});

test("templates: local_implementation registered", () => {
  assert.ok(ACCEPTANCE_TEMPLATES.has(acceptanceKey(INTERNAL_DEV_LOOP_STRATEGY.LOCAL_IMPLEMENTATION, "default")));
});

test("templates: issue_intake registered", () => {
  assert.ok(ACCEPTANCE_TEMPLATES.has(acceptanceKey(INTERNAL_DEV_LOOP_STRATEGY.ISSUE_INTAKE, "default")));
});

test("templates: no duplicate registrations", () => {
  const strategies = Object.keys(STRATEGY_DEFAULT_STOP_RULES);
  const knownKeys = [...ACCEPTANCE_TEMPLATES.keys()];
  for (const s of strategies) {
    const hasDirect = knownKeys.includes(acceptanceKey(s, "default"));
    const hasDraft = knownKeys.includes(acceptanceKey(s, "draft"));
    assert.ok(hasDirect || hasDraft, `Strategy "${s}" has no registered template`);
  }
});

// ===========================================================================
// 19. validateHandoffEnvelope — consumer-side envelope validation
// ===========================================================================

function validEnvelope(opts = {}) {
  return buildDevLoopHandoffEnvelope(
    issueBundle(opts.issue ?? 42, { strategy: opts.strategy, requiredReads: opts.requiredReads }),
    defaultSettings,
    opts.gateState ?? {},
    { ...defaultOptions, ...opts.options }
  );
}

test("validate: fn-exists", () => {
  assert.equal(typeof validateHandoffEnvelope, "function");
});

test("validate: valid envelope returns ok: true", () => {
  const env = validEnvelope();
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings, undefined);
});

test("validate: null envelope returns error", () => {
  const result = validateHandoffEnvelope(null);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "_root"));
});

test("validate: undefined envelope returns error", () => {
  const result = validateHandoffEnvelope(undefined);
  assert.equal(result.ok, false);
});

test("validate: array envelope at root returns error", () => {
  const result = validateHandoffEnvelope(["not", "an", "object"]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "_root"));
});

test("validate: non-object envelope returns error", () => {
  const result = validateHandoffEnvelope("not-an-object");
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "_root"));
});

test("validate: missing handoffVersion returns error", () => {
  const env = { ...validEnvelope() }; delete env.handoffVersion;
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "handoffVersion"));
});

test("validate: negative handoffVersion returns error", () => {
  const env = { ...validEnvelope(), handoffVersion: -1 };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "handoffVersion"));
});

test("validate: wrong handoffVersion returns warning", () => {
  const env = { ...validEnvelope(), handoffVersion: 99 };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some(w => w.field === "handoffVersion"));
});

test("validate: missing target returns error", () => {
  const env = { ...validEnvelope() }; delete env.target;
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "target"));
});

test("validate: missing target.kind returns error", () => {
  const env = { ...validEnvelope(), target: { repo: "a/b" } };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "target.kind"));
});

test("validate: invalid target.kind returns error", () => {
  const env = { ...validEnvelope(), target: { kind: "unknown", repo: "a/b" } };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "target.kind"));
});

test("validate: missing target.repo returns error", () => {
  const env = { ...validEnvelope(), target: { kind: "issue", issue: 1 } };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "target.repo"));
});

test("validate: issue target without issue number returns error", () => {
  const env = { ...validEnvelope(), target: { kind: "issue", repo: "a/b" } };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "target.issue"));
});

test("validate: pr target without pr number returns error", () => {
  const env = buildDevLoopHandoffEnvelope(
    prBundle(10),
    defaultSettings,
    {},
    defaultOptions
  );
  const mutated = { ...env, target: { kind: "pr", repo: "a/b" } };
  const result = validateHandoffEnvelope(mutated);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "target.pr"));
});

test("validate: local_branch target without branch returns error", () => {
  const env = { ...validEnvelope(), target: { kind: "local_branch", repo: "a/b" } };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "target.branch"));
});

test("validate: missing nextAction returns error", () => {
  const env = { ...validEnvelope() }; delete env.nextAction;
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "nextAction"));
});

test("validate: empty nextAction returns error", () => {
  const env = { ...validEnvelope(), nextAction: "  " };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "nextAction"));
});

test("validate: missing requiredReads returns error", () => {
  const env = { ...validEnvelope() }; delete env.requiredReads;
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "requiredReads"));
});

test("validate: requiredReads not an array returns error", () => {
  const env = { ...validEnvelope(), requiredReads: "not-an-array" };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "requiredReads"));
});

test("validate: empty requiredReads returns warning only", () => {
  const env = { ...validEnvelope(), requiredReads: [] };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some(w => w.field === "requiredReads"));
});

test("validate: requiredReads with empty string entries returns error", () => {
  const env = { ...validEnvelope(), requiredReads: ["valid.md", "", "  ", "also-valid.md"] };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "requiredReads"));
});

test("validate: missing acceptance returns error", () => {
  const env = { ...validEnvelope() }; delete env.acceptance;
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "acceptance"));
});

test("validate: acceptance.criteria missing returns error", () => {
  const env = { ...validEnvelope(), acceptance: { evidence: [], maxFinalizationTurns: 4 } };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "acceptance.criteria"));
});

test("validate: acceptance.criteria not an array returns error", () => {
  const env = { ...validEnvelope(), acceptance: { criteria: "not-array", evidence: [], maxFinalizationTurns: 4 } };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "acceptance.criteria"));
});

test("validate: empty acceptance.criteria returns error", () => {
  const env = { ...validEnvelope(), acceptance: { criteria: [], evidence: [], maxFinalizationTurns: 4 } };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "acceptance.criteria"));
});

test("validate: malformed criteria entry (missing id) returns error", () => {
  const base = validEnvelope();
  const env = { ...base, acceptance: { ...base.acceptance, criteria: [{ must: "do something" }] } };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "acceptance.criteria"));
});

test("validate: malformed criteria entry (missing must) returns error", () => {
  const base = validEnvelope();
  const env = { ...base, acceptance: { ...base.acceptance, criteria: [{ id: "test", severity: "required" }] } };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "acceptance.criteria"));
});

test("validate: missing stopRules returns error", () => {
  const env = { ...validEnvelope() }; delete env.stopRules;
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "stopRules"));
});

test("validate: stopRules not an array returns error", () => {
  const env = { ...validEnvelope(), stopRules: "not-an-array" };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "stopRules"));
});

test("validate: stopRules with non-string entries returns error", () => {
  const env = { ...validEnvelope(), stopRules: ["merge", 42, "draft-pr"] };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "stopRules"));
});

test("validate: invalid executionMode returns error", () => {
  const env = { ...validEnvelope(), executionMode: "invalid_mode" };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "executionMode"));
});

test("validate: missing derivedAt returns warning", () => {
  const base = validEnvelope();
  const env = { ...base, gateState: { ...base.gateState } }; delete env.gateState.derivedAt;
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some(w => w.field === "gateState.derivedAt"));
});

test("validate: multiple errors reported together", () => {
  const env = {
    handoffVersion: -5,
    target: { kind: "issue" }, // missing repo
    nextAction: "",
    requiredReads: "not-array",
    stopRules: null,
  };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 4, `expected >=4 errors, got ${result.errors.length}`);
  assert.ok(result.errors.some(e => e.field === "handoffVersion"));
  assert.ok(result.errors.some(e => e.field === "target.repo"));
  assert.ok(result.errors.some(e => e.field === "nextAction"));
  assert.ok(result.errors.some(e => e.field === "requiredReads"));
  assert.ok(result.errors.some(e => e.field === "stopRules"));
  assert.ok(result.errors.some(e => e.field === "acceptance"));
});

test("validate: missing executionMode returns error", () => {
  const env = { ...validEnvelope() }; delete env.executionMode;
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "executionMode"));
});

test("validate: missing asyncStartMode returns error", () => {
  const env = { ...validEnvelope() }; delete env.asyncStartMode;
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "asyncStartMode"));
});

test("validate: target.repo with invalid slug returns error", () => {
  const env = { ...validEnvelope(), target: { kind: "issue", issue: 1, repo: "invalid slug with spaces" } };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "target.repo"));
});

test("validate: target.repo with extra segments returns error (no throw)", () => {
  const env = { ...validEnvelope(), target: { kind: "issue", issue: 1, repo: "a/b/c" } };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "target.repo"));
});

test("validate: target.issue with zero value returns error", () => {
  const env = { ...validEnvelope(), target: { kind: "issue", issue: 0, repo: "a/b" } };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "target.issue"));
});

test("validate: target.issue with negative value returns error", () => {
  const env = { ...validEnvelope(), target: { kind: "issue", issue: -1, repo: "a/b" } };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "target.issue"));
});

test("validate: target.pr with zero value returns error", () => {
  const env = { ...validEnvelope(), target: { kind: "pr", pr: 0, repo: "a/b" } };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "target.pr"));
});

test("validate: target.local_phase without phase or issue returns error", () => {
  const env = { ...validEnvelope(), target: { kind: "local_phase", repo: "a/b" } };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "target.phase"));
});

test("validate: target.local_phase with valid issue but no phase is ok", () => {
  const env = { ...validEnvelope(), target: { kind: "local_phase", issue: 42, repo: "a/b" } };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, true);
});

test("validate: target.local_phase with valid phase is ok", () => {
  const env = { ...validEnvelope(), target: { kind: "local_phase", phase: "implementation", repo: "a/b" } };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, true);
});

test("validate: criteria entry with invalid severity returns error", () => {
  const base = validEnvelope();
  const env = { ...base, acceptance: { ...base.acceptance, criteria: [{ id: "test", must: "do something", severity: "critical" }] } };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "acceptance.criteria"));
});

test("validate: criteria entry without severity returns error (severity is required)", () => {
  const base = validEnvelope();
  const env = { ...base, acceptance: { ...base.acceptance, criteria: [{ id: "test", must: "do something" }] } };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.field === "acceptance.criteria"));
});

test("validate: errors include got values for diagnostics", () => {
  const env = { ...validEnvelope(), handoffVersion: "v1" };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  const err = result.errors.find(e => e.field === "handoffVersion");
  assert.ok(err);
  assert.equal(err.got, "v1");
});

test("validate: accepts valid envelope from all strategies", () => {
  const strategies = [
    { s: INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP, f: issueBundle },
    { s: INTERNAL_DEV_LOOP_STRATEGY.ISSUE_INTAKE, f: issueBundle },
    { s: INTERNAL_DEV_LOOP_STRATEGY.EXTERNAL_PR_FOLLOWUP, f: prBundle },
    { s: INTERNAL_DEV_LOOP_STRATEGY.REVIEWER_FIXER, f: prBundle },
    { s: INTERNAL_DEV_LOOP_STRATEGY.WAIT_WATCH, f: prBundle },
    { s: INTERNAL_DEV_LOOP_STRATEGY.FINAL_APPROVAL, f: prBundle },
    { s: INTERNAL_DEV_LOOP_STRATEGY.REVIEW, f: prBundle },
    { s: INTERNAL_DEV_LOOP_STRATEGY.LOCAL_IMPLEMENTATION, f: localBranchBundle },
  ];
  for (const { s, f } of strategies) {
    const env = f === issueBundle
      ? buildDevLoopHandoffEnvelope(f(99, { strategy: s }), defaultSettings, {}, defaultOptions)
      : f === prBundle
        ? buildDevLoopHandoffEnvelope(f(10, { strategy: s }), defaultSettings, {}, defaultOptions)
        : buildDevLoopHandoffEnvelope(f("feature/x", { strategy: s }), defaultSettings, {}, defaultOptions);
    const result = validateHandoffEnvelope(env);
    assert.equal(result.ok, true, `strategy ${s} should produce valid envelope`);
  }
});

// Invariant: strategy-template coverage
// ===========================================================================

test("invariant: every strategy with default stop rules has an acceptance template", () => {
  const strategies = Object.keys(STRATEGY_DEFAULT_STOP_RULES);
  for (const s of strategies) {
    const key = acceptanceKey(s, "default");
    assert.ok(
      ACCEPTANCE_TEMPLATES.has(key) || ACCEPTANCE_TEMPLATES.has(acceptanceKey(s, "draft")),
      `Strategy "${s}" missing acceptance template`,
    );
  }
});

test("invariant: review is read-only and cannot produce lifecycle gate evidence", () => {
  const stopRules = STRATEGY_DEFAULT_STOP_RULES[INTERNAL_DEV_LOOP_STRATEGY.REVIEW];
  assert.deepEqual(stopRules, ["read-only", "one-review-round", "no-lifecycle-gate-evidence"]);

  const template = ACCEPTANCE_TEMPLATES.get(
    acceptanceKey(INTERNAL_DEV_LOOP_STRATEGY.REVIEW, "default"),
  );
  assert.deepEqual(template.evidence, ["review-findings", "manual-notes"]);
  assert.doesNotMatch(JSON.stringify(template.evidence), /draft_gate|pre_approval_gate/);
  assert.match(JSON.stringify(template), /never satisfies draft_gate or pre_approval_gate evidence/i);
});

test("invariant: ui_review locks its review-boundary stopRules and acceptance criteria ids", () => {
  const stopRules = STRATEGY_DEFAULT_STOP_RULES[INTERNAL_DEV_LOOP_STRATEGY.UI_REVIEW];
  for (const boundary of [
    "no-product-code-writes",
    "worktree-only",
    "outward-review-pending",
    "ack-destructive-migrations",
  ]) {
    assert.ok(stopRules.includes(boundary), `ui_review stopRules must contain "${boundary}"`);
  }

  const template = ACCEPTANCE_TEMPLATES.get(
    acceptanceKey(INTERNAL_DEV_LOOP_STRATEGY.UI_REVIEW, "default"),
  );
  assert.deepEqual(
    template.criteria.map((c) => c.id),
    ["no-product-code-writes", "worktree-only", "outward-review-pending", "ack-destructive-migrations"],
  );
});


// ===========================================================================
// Advisory retrospective findings (issue #1077, Reading B)
//
// The retrospective is advisory: findings travel in the envelope's
// `retrospectiveFindings` field (the check-retro-tooling.mjs JSON output shape)
// for the conductor to surface as an advisory PR comment. They NEVER block.
// ===========================================================================

test("retrospectiveFindings (#1077): omitted by default — field absent", () => {
  const env = buildDevLoopHandoffEnvelope(issueBundle(42), defaultSettings, {}, defaultOptions);
  assert.equal(env.retrospectiveFindings, undefined);
  assert.equal(validateHandoffEnvelope(env).ok, true);
});

test("retrospectiveFindings (#1077): structured findings flow from gateState to the envelope", () => {
  const findings = {
    ok: false,
    internalToolingOnly: false,
    rawCallViolations: ["gh: gh api repos/x/y/pulls/1/comments", "node -e: node -e 'JSON.parse(...)'"],
    allowedWriteOps: ["gh pr merge"],
  };
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    { retrospectiveFindings: findings },
    defaultOptions,
  );
  assert.deepEqual(env.retrospectiveFindings, {
    internalToolingOnly: false,
    rawCallViolations: ["gh: gh api repos/x/y/pulls/1/comments", "node -e: node -e 'JSON.parse(...)'"],
    allowedWriteOps: ["gh pr merge"],
  });
  assert.equal(validateHandoffEnvelope(env).ok, true);
});

test("retrospectiveFindings (#1077): non-empty rawCallViolations do NOT block — envelope stays valid", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    {
      retrospectiveFindings: {
        ok: false,
        internalToolingOnly: false,
        rawCallViolations: ["gh: gh api", "python3: python3 -c 'x'", "node -e: node -e '1'"],
        allowedWriteOps: [],
      },
    },
    defaultOptions,
  );
  // Advisory: findings present, nextAction/gateBoundary unchanged — never a block.
  assert.equal(env.retrospectiveFindings.rawCallViolations.length, 3);
  assert.equal(env.retrospectiveFindings.internalToolingOnly, false);
  assert.equal(validateHandoffEnvelope(env).ok, true);
});

test("retrospectiveFindings (#1077): options.retrospectiveFindings is a fallback source", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    {},
    { ...defaultOptions, retrospectiveFindings: { internalToolingOnly: true, rawCallViolations: [], allowedWriteOps: [] } },
  );
  assert.deepEqual(env.retrospectiveFindings, {
    internalToolingOnly: true,
    rawCallViolations: [],
    allowedWriteOps: [],
  });
});

test("retrospectiveFindings (#1077): gateState takes precedence over options", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    { retrospectiveFindings: { internalToolingOnly: false, rawCallViolations: ["gh: gh api"], allowedWriteOps: [] } },
    { ...defaultOptions, retrospectiveFindings: { internalToolingOnly: true, rawCallViolations: [], allowedWriteOps: [] } },
  );
  assert.equal(env.retrospectiveFindings.internalToolingOnly, false);
  assert.equal(env.retrospectiveFindings.rawCallViolations.length, 1);
});

test("retrospectiveFindings (#1077): null/invalid input yields no field (never blocks)", () => {
  for (const bad of [null, undefined, "not-an-object", 42, []]) {
    const env = buildDevLoopHandoffEnvelope(
      issueBundle(42),
      defaultSettings,
      { retrospectiveFindings: bad },
      defaultOptions,
    );
    assert.equal(env.retrospectiveFindings, undefined, `input ${JSON.stringify(bad)} must not produce a field`);
    assert.equal(validateHandoffEnvelope(env).ok, true);
  }
});

test("retrospectiveFindings (#1077): present-but-invalid gateState falls back to valid options (review fix)", () => {
  // A present-but-invalid gateState value (e.g. a string) must NOT shadow a valid
  // options.retrospectiveFindings fallback. Each source is normalized independently;
  // the options fallback is used when the gateState value normalizes to null.
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    { retrospectiveFindings: "not-an-object" },
    { ...defaultOptions, retrospectiveFindings: { internalToolingOnly: true, rawCallViolations: [], allowedWriteOps: [] } },
  );
  assert.deepEqual(env.retrospectiveFindings, {
    internalToolingOnly: true,
    rawCallViolations: [],
    allowedWriteOps: [],
  });
  assert.equal(validateHandoffEnvelope(env).ok, true);
});

test("retrospectiveFindings (#1077): whitespace entries are trimmed before filtering (review fix)", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    { retrospectiveFindings: { internalToolingOnly: false, rawCallViolations: ["  gh: gh api  ", "   ", ""], allowedWriteOps: [] } },
    defaultOptions,
  );
  // "  gh: gh api  " is trimmed to "gh: gh api"; whitespace-only/empty are dropped.
  assert.deepEqual(env.retrospectiveFindings.rawCallViolations, ["gh: gh api"]);
});

test("retrospectiveFindings (#1077): normalizeRetrospectiveFindings carries the check-retro-tooling JSON shape", () => {
  // Mirrors scripts/loop/check-retro-tooling.mjs --json output.
  const out = normalizeRetrospectiveFindings({
    ok: false,
    internalToolingOnly: false,
    rawCallViolations: ["gh: gh api repos/o/r/pulls/1/comments", "python3: python3 -c 'json.load(...)'"],
    allowedWriteOps: ["gh pr merge", "gh pr ready"],
  });
  assert.deepEqual(out, {
    internalToolingOnly: false,
    rawCallViolations: ["gh: gh api repos/o/r/pulls/1/comments", "python3: python3 -c 'json.load(...)'"],
    allowedWriteOps: ["gh pr merge", "gh pr ready"],
  });
});

test("retrospectiveFindings validation (#1077): malformed field fails validation", () => {
  const env = buildDevLoopHandoffEnvelope(issueBundle(42), defaultSettings, {}, defaultOptions);
  // Hand-build a malformed envelope to exercise the validator.
  const malformed = { ...env, retrospectiveFindings: { internalToolingOnly: "yes", rawCallViolations: "not-array" } };
  const result = validateHandoffEnvelope(malformed);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === "retrospectiveFindings.internalToolingOnly"));
  assert.ok(result.errors.some((e) => e.field === "retrospectiveFindings.rawCallViolations"));
});

test("pendingRetrospectives (#2488): present, empty and null-identity entries are copied into the envelope", () => {
  const withBundle = (pendingRetrospectives) => {
    const input = issueBundle(42);
    input.bundle.pendingRetrospectives = pendingRetrospectives;
    return buildDevLoopHandoffEnvelope(input, defaultSettings, {}, defaultOptions);
  };
  const present = withBundle([{ pr: 7, mergeCommit: "abc123" }]);
  assert.deepEqual(present.pendingRetrospectives, [{ pr: 7, mergeCommit: "abc123" }]);
  assert.equal(validateHandoffEnvelope(present).ok, true);

  const empty = withBundle([]);
  assert.deepEqual(empty.pendingRetrospectives, []);
  assert.equal(validateHandoffEnvelope(empty).ok, true);

  const nullIdentity = withBundle([{ pr: null, mergeCommit: null, reason: "checkpoint_identity_missing" }]);
  assert.deepEqual(nullIdentity.pendingRetrospectives, [{ pr: null, mergeCommit: null, reason: "checkpoint_identity_missing" }]);
  assert.equal(validateHandoffEnvelope(nullIdentity).ok, true);

  assert.equal(Object.hasOwn(buildDevLoopHandoffEnvelope(issueBundle(42), defaultSettings, {}, defaultOptions), "pendingRetrospectives"), false);
});

test("pendingRetrospectives validation (#2488): malformed entries fail validation", () => {
  const env = buildDevLoopHandoffEnvelope(issueBundle(42), defaultSettings, {}, defaultOptions);
  const result = validateHandoffEnvelope({ ...env, pendingRetrospectives: [{ pr: "7", mergeCommit: 5 }] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === "pendingRetrospectives[0].pr"));
  assert.ok(result.errors.some((e) => e.field === "pendingRetrospectives[0].mergeCommit"));
});
