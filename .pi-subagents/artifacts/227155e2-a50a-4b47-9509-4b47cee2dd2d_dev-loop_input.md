# Task for dev-loop

Run the unified dev-loop on GitHub issue #1101 (mfittko/dev-loops) end-to-end through all gates. This is `auto dev loop on issue 1101` with intent `auto_continue_current`. Proceed through the GitHub-first Copilot loop until stop condition or human approval checkpoint. When all gates clear (draft_gate, pre_approval_gate at current head, Copilot convergence, CI green, mergeable CLEAN), the operator has pre-authorized merge: proceed to final approval and merge the PR (squash). 

Execution guardrails (model has wedged before on multi-step gate PRs): do NOT read/cat/edit test files or source files beyond what the sanctioned scripts require. Do NOT reimplement existing changes. Execute the deterministic gate scripts in sequence (draft_gate fanout_fanin → request Copilot → run-watch-cycle.mjs --concise → fixer pass if findings → pre_approval_gate → merge). If a step is ambiguous, run `loop info --pr <n>` and report rather than improvising. Stop only at a genuine human-decision checkpoint. Report PR number, final head SHA, gate verdicts, and merge state on completion.

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