# Task for researcher

## Audit Scope 7: Dedup / Condensation Lens

**Repo**: /Users/mfittko/github/dev-loops
**Baseline commit**: 8cda46da
**Output**: Write findings to `tmp/audits/claude-sonnet-4/scope-7-condensation.md`

### Tasks

**Part A: Word/line counts baseline vs head**
- Compute `wc -w` AND `wc -l` over all contract docs at baseline (8cda46da) vs HEAD
- Contract docs: skills/docs/*.md, skills/*/SKILL.md, docs/*.md, agents/, commands/
- Report total and per-doc deltas
- To get baseline: create temp worktree `git worktree add /tmp/audit-baseline 8cda46da`, compute, then `git worktree remove /tmp/audit-baseline`

**Part B: Growth attribution**
- Categorize line growth into: (a) machine annotation (marker/ID lines like `<!-- rule: ... -->`), (b) genuinely new normative prose, (c) residual verbosity
- Sample representative docs to estimate proportions

**Part C: Semantic dedup pass**
- Find same-behavior rules across families phrased differently
- Find procedures restated as prose around a rule that already owns them
- Find elaboration bullets repeating the rule line

**Part D: Condensation candidates**
- Rank by expected word savings
- Every candidate worth > ~50 words → recommend filing as `pre-v0.8` condensation issue
- State whether epic AC5 ("total corpus word count reduced with zero information loss") is genuinely met against the pre-epic baseline

**Context**: This is audit scope 7 of the v0.8 release gate contract audit (#1192). Epic is #1104.

---
Update progress at: /Users/mfittko/github/dev-loops/.pi-subagents/artifacts/progress/363fd6c8/progress.md

---
**Output:**
Write your findings to exactly this path: /Users/mfittko/github/dev-loops/.pi-subagents/artifacts/outputs/363fd6c8/tmp/audits/claude-sonnet-4/scope-7-condensation.md
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