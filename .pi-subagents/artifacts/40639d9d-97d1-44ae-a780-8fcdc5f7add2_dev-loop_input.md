# Task for dev-loop

Run the unified dev-loop on GitHub issue #1082 (mfittko/dev-loops) end-to-end through all gates. This is `auto dev loop on issue 1082` with intent `auto_continue_current`. Operator authorization: start implementation, create/reuse the canonical PR, continue through GitHub/Copilot loop, and merge (squash) when all gates honestly clear.

Hard constraints:
- Follow the dev-loop startup resolver + handoff envelope. Main agent did not run startup.
- Always use a worktree; fetch origin before creating/reusing it.
- Merge is explicitly pre-authorized ONLY after honest gate completion: draft_gate current head, Copilot convergence, pre_approval_gate current head, CI green, mergeable CLEAN, pre-merge evidence check ok.
- Do NOT fabricate `fanout_fanin` evidence. If a gate resolves to `full_fanout` and your runtime cannot dispatch real fresh-context review subagents / produce real per-angle findings artifacts, STOP and report the exact blocker. Do not write empty/inline findings logs labeled fanout_fanin.
- If stale fresh-context sentinels block review startup, report that issue #1108 exists; do not delete sentinels unless the routed procedure explicitly authorizes it.
- If a step is ambiguous, run `loop info --issue 1082` or `loop info --pr <n>` and report rather than improvising.

On completion or blocker, report issue, PR, head SHA, gate verdicts/evidence mode, CI, merge state, and next action.

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