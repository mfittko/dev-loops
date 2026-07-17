Implementation complete and committed. Here's the structured acceptance report.

## Summary

Issue #1077 implemented under Reading B (committed design). The retrospective is now **advisory**: it runs and returns findings to the conductor via the handoff envelope's structured `retrospectiveFindings` field + an advisory PR comment — **never a gate, never on disk**.

**Scope decision (confirmed with supervisor):** (A) MINIMAL — removed only the merge-blocking findings gate + the two removed config keys. The startup/resume **completion** gate (`evaluateRetrospectiveGate`, `requireRetrospective`) is intentionally retained and out of scope (#1077 Non-goals) — it gates on *completion*, not on raw-call findings.

**Key changes:**
- `pr-gate-coordination.mjs`: removed `evaluateRetrospectiveMergeApproval` + `buildRetrospectiveGatePendingResult` + `summarizeRawCallViolations` and all 4 call sites → no `retrospective_gate_pending`/`blocked` on `rawCallViolations`.
- `detect-pr-gate-coordination-state.mjs`: stopped reading/feeding the retro checkpoint + removed config keys into the merge gate.
- `config.mjs` + schema/defaults/extension-defaults/`.devloops`/fixture: removed `requireRetrospectiveGate` + `requireRetrospectiveInternalTooling` (kept `requireRetrospective`).
- `handoff-envelope.mjs`: added structured `retrospectiveFindings` field `{internalToolingOnly, rawCallViolations, allowedWriteOps}` (sourced from gateState/options) + consumer-side validation. **Hard acceptance criterion.**
- `check-retro-tooling.mjs`: unchanged findings-producer; its JSON now flows to the envelope.
- `lifecycle-state.mjs:136`: reconciled MERGE next-action text (post-merge/advisory) → resolves the lifecycle-state vs pr-gate-coordination contradiction.
- Docs reconciled (retrospective-checkpoint-contract.md rewritten, dev-loop SKILL.md, anti-patterns.md, extension/README.md) + regenerated `.claude` asset copies.
- Tests rewritten to assert advisory (non-blocking) behavior + new envelope `retrospectiveFindings` coverage.

**Note on `detect-checkpoint-evidence.mjs`:** the issue lists it as "drops the retro check," but `buildPreMergeGateCheck` contains **no** retro check (verified) — it checks draft gate, pre-approval gate, fan-out evidence, unresolved threads, stale runner. Nothing to drop; already consistent with Reading B.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Scoped to the locked Reading B surface only: removed the merge-blocking retro gate (evaluateRetrospectiveMergeApproval + 4 call sites + helpers), the two removed config keys (requireRetrospectiveGate, requireRetrospectiveInternalTooling), and added the envelope retrospectiveFindings field. The startup/resume completion gate (requireRetrospective) is intentionally retained (out of scope per #1077 Non-goals); no routing/conductor changes. detect-checkpoint-evidence.mjs had no retro check to drop (verified). No unrelated changes."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Committed diff at 96c7f532 on branch issue-1077; npm run verify green (0 failures); unit coverage for all 5 issue acceptance criteria (rawCallViolations non-empty never blocks; findings surfaced via envelope retrospectiveFindings; no retrospective_gate_pending/blocked from the raw-call record; lifecycle text reconciled; advisory result). Evidence enumerated below."
    }
  ],
  "changedFiles": [
    "packages/core/src/loop/pr-gate-coordination.mjs",
    "packages/core/src/loop/handoff-envelope.mjs",
    "packages/core/src/loop/lifecycle-state.mjs",
    "packages/core/src/config/config.mjs",
    "packages/core/src/config/extension-defaults.yaml",
    "scripts/loop/detect-pr-gate-coordination-state.mjs",
    "scripts/loop/build-handoff-envelope.mjs",
    "schemas/dev-loop-config.schema.json",
    ".devloops",
    "extension/README.md",
    "skills/docs/retrospective-checkpoint-contract.md",
    "skills/dev-loop/SKILL.md",
    "skills/docs/anti-patterns.md",
    ".claude/skills/docs/retrospective-checkpoint-contract.md",
    ".claude/skills/dev-loop/SKILL.md",
    ".claude/skills/docs/anti-patterns.md",
    "test/fixtures/devloops-defaults",
    "packages/core/test/pr-gate-coordination.test.mjs",
    "packages/core/test/handoff-envelope.test.mjs",
    "packages/core/test/config.test.mjs",
    "test/loop/detect-pr-gate-coordination-state.test.mjs"
  ],
  "testsAddedOrUpdated": [
    "packages/core/test/pr-gate-coordination.test.mjs (rewrote retro merge-gate suite to assert advisory non-blocking behavior; 7 advisory tests incl. non-empty rawCallViolations never blocks, missing/missing-fields checkpoints never block, removed config keys ignored)",
    "packages/core/test/handoff-envelope.test.mjs (8 new retrospectiveFindings tests: field absent by default, structured findings flow from gateState, non-empty rawCallViolations do NOT block, options fallback, gateState precedence, null/invalid never blocks, normalizeRetrospectiveFindings shape, malformed-field validation)",
    "packages/core/test/config.test.mjs (removed requireRetrospectiveGate/requireRetrospectiveInternalTooling references from schema/defaults/loader/resolveWorkflowConfig tests)",
    "test/loop/detect-pr-gate-coordination-state.test.mjs (retro-gate-blocks test → advisory: green PR with no checkpoint reaches final approval, never retrospective_gate_pending)"
  ],
  "commandsRun": [
    {
      "command": "node scripts/loop/pre-flight-gate.mjs --expected-branch issue-1077 --check-subagents",
      "result": "passed",
      "summary": "worktree isolation + branch identity verified"
    },
    {
      "command": "npm run verify",
      "result": "passed",
      "summary": "All suites green (assets 145, extension 82, scripts 2045, core 1815, docs links+rules, dev-loop 32). 0 failures. Run with PI_SUBAGENT_RUN_ID unset (see residual risks)."
    },
    {
      "command": "node scripts/claude/generate-claude-assets.mjs",
      "result": "passed",
      "summary": "regenerated .claude asset copies after skill/doc edits; claude-assets-reproducible test passes"
    },
    {
      "command": "node --test <focused: pr-gate-coordination, handoff-envelope, config, retrospective-checkpoint, detect-pr-gate-coordination-state, check-retro-tooling>",
      "result": "passed",
      "summary": "528 pass / 1 skipped / 0 fail"
    }
  ],
  "validationOutput": [
    "npm run verify: 0 failures across test:assets, test:extension, test:scripts, test:core, test:docs, test:dev-loop",
    "Repo .devloops loads with 0 config errors after removing the two keys (requireRetrospective retained)",
    "check-retro-tooling.mjs findings-producer test: 13/13 pass (unchanged logic, now feeds the envelope)",
    "Claude-Code path non-regression: extension-claude-adapter + headless-dev-loop smoke tests pass; retrospectiveFindings field is harness-agnostic",
    "Acceptance criteria covered by tests: rawCallViolations non-empty → FINAL_APPROVAL_READY (not blocked); findings in envelope retrospectiveFindings; no retrospective_gate_pending from raw-call record; lifecycle text reconciled"
  ],
  "residualRisks": [
    "Pre-existing environmental test flake (NOT a regression): packages/core/test/run-context.test.mjs 'resolveRunId trims and treats blank/absent as null' fails when the pi runtime sets PI_SUBAGENT_RUN_ID in process.env — fails identically on origin/main. Passes with the var unset. verify was run with PI_SUBAGENT_RUN_ID/PI_SUBAGENT_PARENT_ROOT_RUN_ID unset.",
    "The startup/resume completion gate (evaluateRetrospectiveGate + requireRetrospective) is retained and now inert re: findings (it gates on completion, not raw-call violations). Whether it should exist at all is deferred to a SEPARATE follow-up per #1077 Non-goals — noted, not implemented here.",
    "Worktree node_modules/@dev-loops/core symlink was provisioned manually (the worktree had none, so @dev-loops/core resolved up to the stale main checkout). It is gitignored and NOT committed; a clean checkout/provision may need to recreate it for test runs.",
    "Advisory PR comment posting is a conductor-agent procedure documented in the contract; no code path in conductor.mjs was added for it (conductor.mjs retains the unchanged completion gate)."
  ],
  "noStagedFiles": true,
  "diffSummary": "Removes the pre-merge retrospective findings gate entirely (evaluateRetrospectiveMergeApproval + helpers + 4 call sites in pr-gate-coordination.mjs; retro checkpoint + removed config keys no longer fed by detect-pr-gate-coordination-state.mjs) and the two config keys requireRetrospectiveGate/requireRetrospectiveInternalTooling across schema/defaults/extension-defaults/.devloops/fixture. Adds a structured advisory retrospectiveFindings field to the handoff envelope (the check-retro-tooling.mjs JSON shape) with validation. Reconciles lifecycle-state.mjs MERGE text and the retrospective-checkpoint-contract.md + skill/extension docs to advisory/post-merge. Rewrites tests to assert non-blocking advisory behavior. Net -217 lines.",
  "reviewFindings": [
    "no blockers",
    "minor: the retained requireRetrospective completion gate is now effectively inert re: findings (nothing writes behavioralReview findings to disk anymore) — acceptable per the confirmed (A) MINIMAL scope; flagged as a follow-up, not this PR"
  ],
  "manualNotes": "Committed as 96c7f532 on branch issue-1077 in worktree tmp/worktrees/dev-loops/issue-1077. Stopped before merge/PR per instructions. Next action: create PR via `dev-loops pr create --assignee @me` (draft, Closes #1077), then gate. Verify was run with PI_SUBAGENT_RUN_ID unset to avoid the pre-existing run-context env flake."
}
```

**Next recommended action:** create the PR via `dev-loops pr create --assignee @me` (draft, body includes `Closes #1077`), then run the gate. Authorization needed before merge.