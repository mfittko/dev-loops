import assert from "node:assert/strict";
import test from "node:test";

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
} from "../src/loop/handoff-envelope.mjs";

import {
  DEV_LOOP_TARGET_KIND,
  INTERNAL_DEV_LOOP_STRATEGY,
  DEV_LOOP_EXECUTION_MODE,
} from "../src/loop/public-dev-loop-routing-contract.mjs";

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
      },
    },
  };
}

function nullStrategyBundle() {
  return {
    bundle: {
      selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.NONE,
      executionMode: DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF,
      nextAction: "No action.",
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
      blockCleanOnFindingSeverities: ["must-fix"],
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
  assert.equal(typeof env.derivedAt, "string");
  assert.ok(env.derivedAt.endsWith("Z") || env.derivedAt.includes("T"));
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
  assert.ok(env.acceptance.criteria.some((c) => c.id === "verify-green"));
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

  assert.equal(env.currentHeadSha, "abc123def456");
  assert.equal(env.ciStatus, "success");
  assert.equal(env.unresolvedThreadCount, 3);
  assert.equal(env.copilotRoundCount, 2);
});

test("gate-state: null/undefined values default to null or 0", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    null,
    defaultOptions
  );

  assert.equal(env.currentHeadSha, null);
  assert.equal(env.ciStatus, null);
  assert.equal(env.unresolvedThreadCount, 0);
  assert.equal(env.copilotRoundCount, 0);
});

test("gate-state: empty gate state is safe", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    {},
    defaultOptions
  );

  assert.equal(env.currentHeadSha, null);
  assert.equal(env.ciStatus, null);
  assert.equal(env.unresolvedThreadCount, 0);
  assert.equal(env.copilotRoundCount, 0);
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
  assert.deepEqual(env.gateConfig.blockCleanOnFindingSeverities, ["must-fix"]);
});

test("gate-config: pre-approval gate config from settings", () => {
  const settings = {
    ...defaultSettings,
    gates: {
      draft: { angles: ["scope"], requireCi: true, blockCleanOnFindingSeverities: ["must-fix"] },
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
        angles: ["scope", "coverage", "deep"],
        excludeAngles: ["deep"],
        requireCi: true,
        blockCleanOnFindingSeverities: ["must-fix"],
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

test("cwd: null when no repoRoot or explicit cwd", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    {},
    defaultOptions
  );

  assert.equal(env.cwd, null);
});

// ===========================================================================
// 13. Backward compat — acceptance shape maps to subagent contract
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
  assert.strictEqual(e1.derivedAt, frozen);
  assert.strictEqual(e2.derivedAt, frozen);
  assert.strictEqual(e1.derivedAt, e2.derivedAt);
});

test("determinism: derivedAt defaults to current time when now not provided", () => {
  const before = new Date().toISOString();
  const e = buildDevLoopHandoffEnvelope(issueBundle(99), defaultSettings, {}, defaultOptions);
  assert.ok(e.derivedAt >= before);
});

test("backward-compat: envelope is frozen (top-level)", () => {
  const env = buildDevLoopHandoffEnvelope(
    issueBundle(42),
    defaultSettings,
    {},
    defaultOptions
  );

  assert.throws(() => { env.acceptance = null; }, /Cannot assign to read only property/);
  assert.throws(() => { env.stopRules = []; }, /Cannot assign to read only property/);
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

  assert.equal(env.copilotRoundCount, 0);
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
  const env = { ...validEnvelope() }; delete env.derivedAt;
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some(w => w.field === "derivedAt"));
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
