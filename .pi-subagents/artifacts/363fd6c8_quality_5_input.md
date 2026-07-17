# Task for quality

## Audit Scope 8: Release Readiness

**Repo**: /Users/mfittko/github/dev-loops
**Output**: Write findings to `tmp/audits/claude-sonnet-4/scope-8-release-readiness.md`

### Tasks

1. Run and capture output of:
   - `npm run verify`
   - `npm run test:docs` (if exists in package.json)
   - `npm run test:assets` (if exists in package.json)
   - `npm test` (if exists in package.json)

2. Check that release pipeline is intact:
   - Check `.github/workflows/release.yml` dispatches npm-publish
   - Check fix #1187 is merged and effective

3. Check that main branch is clean:
   - `git status` clean
   - No open PRs blocking release
   - All v0.8 milestone issues closed (check `gh issue list --milestone v0.8 --state open`)

4. Check package.json version is ready for release

**Context**: This is audit scope 8 of the v0.8 release gate contract audit (#1192). Epic is #1104.

---
**Output:**
Write your findings to exactly this path: /Users/mfittko/github/dev-loops/.pi-subagents/artifacts/outputs/363fd6c8/tmp/audits/claude-sonnet-4/scope-8-release-readiness.md
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