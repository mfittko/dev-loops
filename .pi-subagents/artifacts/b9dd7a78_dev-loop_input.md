# Task for dev-loop

You are reviving a previous subagent conversation.

Original run: 9f2424b9
Original agent: dev-loop
Original session file: /Users/mfittko/.pi/agent/sessions/--Users-mfittko-github-dev-loops--/2026-07-02T08-44-00-155Z_019f21ff-cd1b-7f6d-af82-82ea26631ffc/4aebe722/run-0/session.jsonl

Use the stored session context as background. Answer the orchestrator's follow-up below. Do not assume the original child process is still alive.

Follow-up:
You stalled after misinvoking probe-copilot-review.mjs (you got its --help, exit 2, because you omitted --repo/--pr). The Copilot review on PR #1085 ALREADY landed — you saw the thread comments in the watch output. Do not re-run the watch cycle. Proceed:

1. Capture the settled review properly: `node <pkg>/cli/index.mjs gate capture-threads --repo mfittko/dev-loops --pr 1085` (or `probe-copilot-review.mjs --repo mfittko/dev-loops --pr 1085 --concise` — BOTH flags required). The review raised 5 thread comments; at least one is a real correctness finding.
2. Run the fixer path against the REAL findings (commit a fix-up to issue-1077, push):
   - **Correctness (must fix):** precedence `gateState?.retrospectiveFindings ?? options.retrospectiveFindings` drops the valid options fallback when gateState's value is present-but-invalid (e.g. a string). Normalize each source independently, then `??` on the normalized values.
   - **Test quality:** tighten the advisory tests to assert the intended success boundary (`final_approval_ready`) and action (`await_final_human_approval`), not just "not blocked".
   - **Docs:** remove `requireRetrospectiveGate`/`requireRetrospectiveInternalTooling` from the workflow-keys doc list (removed by this PR); reconcile the envelope-shape doc to `{internalToolingOnly, rawCallViolations, allowedWriteOps}` (drop the `ok` reference, or note normalizeRetrospectiveFindings drops it).
   - **Minor:** trim whitespace in normalizeRetrospectiveFindings before filtering.
3. Reply-resolve all 5 threads via reply-resolve-review-thread.mjs (record the fix-commit SHA for the real ones; mark nits acknowledged/deferred).
4. Re-verify: `npm run verify` green (unset PI_SUBAGENT_RUN_ID for the run-context flake); CI green via probe-ci-status.mjs. Use dev-loops wrappers only — NO raw gh/node -e.
5. After threads resolved (0 unresolved) + review settled, post the pre_approval_gate verdict (fanout_fanin). NOTE: if you pushed a fix-commit, the head SHA changed from 96c7f532 — rebuild gate context + ledger for the NEW head before posting. detect-checkpoint-evidence.mjs must be ok:true on the new head.
6. STOP at the human approval checkpoint. Do NOT merge, do NOT enable auto-merge.
7. Report: fix-commit SHA, findings fixed vs deferred, thread-resolution status, pre_approval_gate verdict (fanout_fanin) + head SHA, preMergeGateCheck result, CI/verify status, next action (merge authorization).

If the coordination state still forbids pre_approval_gate after thread resolution (e.g. round-cap reached), report the state and stop — do not force.

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