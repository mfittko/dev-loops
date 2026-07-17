# Task for review

Independent v0.8 release audit for issue #1192, lane C: semantic drift spot-checks and epic closeout. Work in /Users/mfittko/github/dev-loops. Read issue #1192 and issue #1104 body/comments. Do not mutate tracked files. Baseline is parent of first epic commit 02bd0de0 unless evidence points elsewhere. Sample reworded rules from each batch (#1147/#1148/#1149/#1150/#1151/#1156/#1157/#1158/#1153/#1154/#1159 plus post-epic #1190/#1200/#1205/#1207/#1210/#1193) against git history. Verify #1104 AC1-AC6 and DoD1-DoD3 evidence, especially word-count roll-up/closing comment. Return blockers with exact evidence.

---
Update progress at: /Users/mfittko/github/dev-loops/.pi-subagents/artifacts/progress/075fa7dc/progress.md

---
**Output:**
Write your findings to exactly this path: /Users/mfittko/github/dev-loops/.pi-subagents/artifacts/outputs/075fa7dc/tmp/audits/lane-c-drift-closeout.md
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