# Task for review

Independent v0.8 release audit for issue #1192, lane D: dedup / condensation lens. Work in /Users/mfittko/github/dev-loops. Read issue #1192 body. Do not mutate tracked files. Compute or validate hard numbers for corpus paths: skills/docs, docs/, skills/*/SKILL.md, agents/, commands/ at baseline parent of 02bd0de0 vs current HEAD: wc -w and wc -l total and per doc. Attribute growth to rule marker/ID lines vs genuinely new normative prose vs residual verbosity where feasible. Do semantic dedup pass for same-behavior rules across families, procedure prose restating owned rules, elaboration bullets repeating rule lines. Produce ranked condensation candidates >~50 words with expected savings and note if each should become pre-v0.8 issue.

---
Update progress at: /Users/mfittko/github/dev-loops/.pi-subagents/artifacts/progress/075fa7dc/progress.md

---
**Output:**
Write your findings to exactly this path: /Users/mfittko/github/dev-loops/.pi-subagents/artifacts/outputs/075fa7dc/tmp/audits/lane-d-condensation.md
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