# Task for review

Gate-review subagent. PR mfittko/dev-loops #1107 (draft_gate, head 08b8fc07). SINGLE REVIEW ANGLE: determinism. Read the diff at /Users/mfittko/github/dev-loops/tmp/gate-context/mfittko-dev-loops/pr-1107/diff-08b8fc07.patch and scripts/github/probe-copilot-review.mjs. Verify: does --timeout-ms 0 produce a deterministic single-check result ('idle') with no polling/timing variance? Any nondeterministic path introduced? Produce findings JSON to the output path: {"angle":"determinism","verdict":"clean"|"findings_present","findings":[{"severity":"must-fix"|"worth-fixing-now"|"defer","summary":"...","file":"...","line":N,"recommendation":"..."}]}. clean ⟹ empty findings. Be rigorous. Do NOT modify files; only write output JSON.

---
**Output:**
Write your findings to exactly this path: /Users/mfittko/github/dev-loops/.pi-subagents/artifacts/outputs/f3f5eefd/tmp/gate-context/mfittko-dev-loops/pr-1107/draft_gate-determinism.json
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

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