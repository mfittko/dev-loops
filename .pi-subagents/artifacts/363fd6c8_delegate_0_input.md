# Task for delegate

## Audit Scope 1 & 2: Rule Ownership + L2/L3 Conformance

**Repo**: /Users/mfittko/github/dev-loops
**Output**: Write findings to `tmp/audits/claude-sonnet-4/scope-1-2-ownership-conformance.md`

### Tasks

1. Run `node scripts/docs/validate-rule-ownership.mjs` and capture full output. Verify:
   - Every normative doc opens with canonical-owner line
   - No rule restated outside its owner doc
   - Required-rules manifest covers the corpus
   - DoD2: `validate-no-duplicate-rules.mjs` retired or subsumed with unique checks ported

2. Run `node scripts/docs/validate-state-machine-conformance.mjs` and capture full output. Verify:
   - ALL wired machines pass (pr-gate-coordination, conductor-routing, copilot-loop-state, reviewer-loop-state)
   - Any others that should be wired but aren't (check skills/docs/ for machine definitions)
   - No STALE known-gap/allowlist entries (each must reference an open tracking issue)
   - L3 completeness, safety, liveness passed for all machines

3. Check `scripts/docs/validate-links.mjs` also passes if it exists.

**Context**: This is audit scope 1+2 of the v0.8 release gate contract audit (#1192). Epic is #1104.

---
**Output:**
Write your findings to exactly this path: /Users/mfittko/github/dev-loops/.pi-subagents/artifacts/outputs/363fd6c8/tmp/audits/claude-sonnet-4/scope-1-2-ownership-conformance.md
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