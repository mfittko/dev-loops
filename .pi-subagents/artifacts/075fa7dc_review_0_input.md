# Task for review

Independent v0.8 release audit for issue #1192, lane A: rule ownership, phrase-pin zero-state, contradiction/modality scan. Work in /Users/mfittko/github/dev-loops. Read issue #1192 body and note it has no comments. Do not mutate tracked files. You may run read-only commands and validators. Store/return concise findings with exact evidence, commands, exit codes, and blocking/non-blocking classification. Focus on: scripts/docs/validate-rule-ownership.mjs; required-rules manifest coverage; canonical-owner opening lines in normative docs; no restated rules outside owners; deterministic modality-conflict state; exact-sentence pins in test/contracts. Output should be a Markdown audit lane report.

---
Update progress at: /Users/mfittko/github/dev-loops/.pi-subagents/artifacts/progress/075fa7dc/progress.md

---
**Output:**
Write your findings to exactly this path: /Users/mfittko/github/dev-loops/.pi-subagents/artifacts/outputs/075fa7dc/tmp/audits/lane-a-rule-ownership.md
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