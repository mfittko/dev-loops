# Task for delegate

## Audit Scope 5: Semantic-Drift Spot-Checks

**Repo**: /Users/mfittko/github/dev-loops
**Baseline commit**: 8cda46da (pre-epic, before batch #1147)
**Output**: Write findings to `tmp/audits/claude-sonnet-4/scope-5-semantic-drift.md`

### Tasks

1. Sample reworded rules from every batch against their pre-epic baselines via git history.
   - The batches (with merge commits):
     - #1147: 02bd0de0 (ownership foundation)
     - #1148: d0f2488a (state-machine conformance)
     - #1149: d1064eb5 (gate contract cluster)
     - #1150: 933c03c5 (public-dev-loop-contract)
     - #1151: e27602bf (worktree rules)
     - #1153: bdcba720 (local-implementation SKILL)
     - #1154: 624a0fda (copilot-pr-followup SKILL)
     - #1156: 78ae3d9e (queue/board + conductor-routing)
     - #1157: 97c11fa7 (copilot/reviewer state-graph)
     - #1158: 7685a423 (intake/spike/epic + lifecycle)
     - #1159: 4c50e1c9 (final sweep)

2. For each batch, pick 1-2 representative rules that were reworded. Compare the pre-epic (8cda46da) version vs the current version. Verify:
   - Zero meaning change
   - Conditions, guards, exceptions intact
   - No modality upgrade/downgrade without intent

3. Use `git diff 8cda46da..HEAD -- skills/docs/ skills/ docs/ agents/ commands/` to see all changes, then sample.

**Context**: This is audit scope 5 of the v0.8 release gate contract audit (#1192). Epic is #1104.

---
**Output:**
Write your findings to exactly this path: /Users/mfittko/github/dev-loops/.pi-subagents/artifacts/outputs/363fd6c8/tmp/audits/claude-sonnet-4/scope-5-semantic-drift.md
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