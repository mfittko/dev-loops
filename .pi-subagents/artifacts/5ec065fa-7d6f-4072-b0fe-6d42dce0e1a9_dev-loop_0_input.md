# Task for dev-loop

Final approval + merge for issue #1056 / PR #1078, repo mfittko/dev-loops.

Inputs: issue=1056, pr=1078, head=b4bba6a50e05128260e82830cab64ff1945c6e04. Gate state already complete: draft_gate clean (satisfied), pre_approval_gate clean fanout_fanin on current head, preMergeGateCheck ok:true, CI success, 0 unresolved threads, mergeStateStatus CLEAN, mergeable MERGEABLE.

Authorization: HUMAN MERGE EXPLICITLY AUTHORIZED for this PR (gate-complete threshold met: clean draft_gate + current-head pre_approval_gate fanout_fanin, no must-fix/worth-fixing-now findings, CI green, Copilot converged at round cap).

Procedure:
1. Resolve dev-loops package root via bounded candidates (node module resolution → ~/.pi/agent/npm/node_modules/dev-loops → package-relative → global). Never unbounded find.
2. Load final-approval skill + copilot-pr-followup skill + copilot-loop-operations.
3. Re-verify live merge preconditions at merge time: `loop info --pr 1078`, `detect-checkpoint-evidence.mjs` (preMergeGateCheck must be ok:true), current CI green, mergeStateStatus CLEAN. If any precondition regressed since the gate run, STOP and report — do not force.
4. Retrospective merge gate (requireRetrospectiveGate:true, requireRetrospectiveInternalTooling:true): the repo-level `.pi/dev-loop-retrospective-checkpoint.json` currently records PR #1073, not #1078. A qualifying completion should trigger a fresh state:required checkpoint. Satisfy the retrospective gate for THIS PR (complete + mergeApproved:true + internalToolingOnly:true + empty rawCallViolations) per the retrospective-checkpoint-contract before merging. If the retro gate cannot be satisfied cleanly, STOP and report — do not bypass.
5. Execute the merge via the final-approval skill's sanctioned merge path (squash). Use the dev-loops merge wrapper if one exists; otherwise the final-approval skill's merge procedure. Do NOT use a raw `gh pr merge` from this subagent if a wrapper is available.
6. Post-merge: confirm PR state MERGED, linked issue #1056 closure, and report the merge SHA.
7. Report back: merge verdict, SHA, retro-gate outcome, any post-merge notes.

---
**Output:**
Write your findings to exactly this path: /Users/mfittko/github/dev-loops/.pi-subagents/artifacts/outputs/5ec065fa-7d6f-4072-b0fe-6d42dce0e1a9/tmp/dev-loop-runs/pr-1078-merge.out.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

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