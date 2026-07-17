# Task for dev-loop

Implement issue #1077, repo mfittko/dev-loops. Tracker-first local implementation.

Issue: #1077 — "fix(loop): retrospective must be advisory (report flagged calls to the conductor) — NEVER block merge or any transition". Milestone v0.7. The design is LOCKED in the issue body under "## Design decision (Reading B — committed)" — read it first; do not re-litigate the design.

Committed design (Reading B — return-only, no artifact, no retro gate):
1. Durability — advisory PR comment: the conductor posts a single advisory PR comment carrying the retro findings (rawCallViolations, internalToolingOnly, allowedWriteOps). Durable, on-GitHub, not a gate. No disk artifact for retro.
2. Deterministic return contract — the loop subagent's handoff envelope MUST include a structured `retrospectiveFindings` field (the check-retro-tooling.mjs JSON output), not prose. The conductor reads that field. Hard acceptance criterion.
3. Config fate — remove both `requireRetrospectiveGate` and `requireRetrospectiveInternalTooling`. The retro always runs and always returns findings; nothing to configure.

Concrete code surface (from the issue):
- `evaluateRetrospectiveMergeApproval` (`packages/core/src/loop/pr-gate-coordination.mjs`) — removed or passthrough; no `retrospective_gate_pending` / `blocked` on `rawCallViolations`.
- `detect-checkpoint-evidence.mjs` — drops the retro check.
- `checkpoint-contract.mjs` — no longer writes retro state (the behavioralReview field-write gap is moot under B).
- `.pi/dev-loop-retrospective-checkpoint.json` — no longer the retro source of truth (delete or repurpose).
- `check-retro-tooling.mjs` — still runs, as a findings-producer whose JSON is returned to the conductor via the envelope's `retrospectiveFindings` field, not written to a checkpoint.
- Reconcile the lifecycle-state.mjs:136 vs pr-gate-coordination.mjs:1064 contradiction (retro documented as post-merge but enforced as pre-merge).

Live evidence to reference (from this session): PR #1079's merge hit `retrospective_gate_pending` from the state machine (post-merge checkpoint lacked behavioralReview.mergeApproved:true via checkpoint-contract.mjs's field-write gap) WHILE `detect-checkpoint-evidence` preMergeGateCheck returned ok:true — the two disagreed. Reading B eliminates this class.

Procedure:
1. Resolve dev-loops package root via bounded candidates (node module resolution → ~/.pi/agent/npm/node_modules/dev-loops → package-relative → global). Never unbounded find.
2. Run `loop startup --issue 1077` then `loop build-envelope --input <resolver-output>`. Load only requiredReads.
3. Worktree cwd (mandatory): fetch origin first, use a worktree checkout for all git/file/validation ops — never the main checkout.
4. Load the local-implementation skill; implement phase-bounded, test-first. Cover the acceptance criteria in the #1077 issue body (unit coverage: a retro with rawCallViolations yields an advisory not blocking result; violations appear in the conductor decision input / envelope retrospectiveFindings field; no lifecycle action forbidden by them; no retrospective_gate_pending/blocked disposition from the internal-tooling record).
5. Run `npm run verify` as the default local validation path. All tests must pass.
6. Non-regression (hard): dev-loops is harness-agnostic (Pi + Claude Code). The retro advisory path must work on BOTH harnesses. Add/keep Claude-Code-path coverage; do not regress it.
7. Stop before merge — do NOT merge, do NOT mark ready-for-review, do NOT create a PR unless the local-implementation skill's procedure authorizes it. This run is implementation + local validation; report the diff, test results, and that it's ready for the gate/PR step.
8. Report back: files changed, test results (npm run verify), acceptance-criteria coverage, residual risks, and the explicit next action (likely: create PR via dev-loops pr create, then gate).

## Acceptance Contract
Acceptance level: reviewed
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope
- criterion-2: Return evidence sufficient for an independent acceptance review

Required evidence: changed-files, tests-added, commands-run, validation-output, residual-risks, no-staged-files

Review gate: required by reviewer.

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```