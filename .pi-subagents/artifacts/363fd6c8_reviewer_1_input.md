# Task for reviewer

[Read from: /Users/mfittko/github/dev-loops/plan.md, /Users/mfittko/github/dev-loops/progress.md]

## Audit Scope 3 & 4: Contradiction Scan + Phrase-Pin Zero-State

**Repo**: /Users/mfittko/github/dev-loops
**Output**: Write findings to `tmp/audits/claude-sonnet-4/scope-3-4-contradiction-pins.md`

### Tasks

1. **Contradiction Scan (Scope 3)**:
   - Scan ALL normative docs under skills/docs/, skills/*/SKILL.md, docs/, agents/, commands/ for RFC-2119 conflicts
   - Look for: MUST vs MUST NOT on the same behavior, conflicting guards/preconditions, modality downgrades (MUST → SHOULD on same rule in different docs)
   - Check if the deterministic modality-conflict scan from #1159 is gating and clean
   - Look specifically for rules referenced by ID that contradict the owner doc's wording

2. **Phrase-Pin Zero-State (Scope 4)**:
   - Search test/ and contracts/ directories (and any validation scripts) for exact-sentence pins on normative prose
   - Look for string literals matching normative doc sentences in test assertions
   - Verify AC2: zero exact-sentence pins on normative prose remain
   - Check if any test files still use phrase-pin assertions instead of rule-ID/structural checks

**Context**: This is audit scope 3+4 of the v0.8 release gate contract audit (#1192). Epic is #1104.

---
**Output:**
Write your findings to exactly this path: /Users/mfittko/github/dev-loops/.pi-subagents/artifacts/outputs/363fd6c8/tmp/audits/claude-sonnet-4/scope-3-4-contradiction-pins.md
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