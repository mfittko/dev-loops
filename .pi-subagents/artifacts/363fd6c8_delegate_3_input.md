# Task for delegate

## Audit Scope 6: Epic #1104 Closeout Verification

**Repo**: /Users/mfittko/github/dev-loops
**Output**: Write findings to `tmp/audits/claude-sonnet-4/scope-6-epic-closeout.md`

### Tasks

Verify epic #1104 AC1-AC6 and DoD1-DoD3. Read https://github.com/mfittko/dev-loops/issues/1104 body for full AC/DoD text.

**AC1**: Every normative doc opens with canonical-owner line, tags rules with IDs in RFC-2119, never restates rules owned elsewhere.
- Sample ~10 docs from skills/docs/, skills/*/SKILL.md, docs/ to verify

**AC2**: ~880 phrase-pin assertions replaced by rule-ID/structural checks; zero exact-sentence pins remain.
- Search test/ and any pin-related directories for remaining phrase-pins

**AC3**: All named state machines L2-conformance-checked and L3 invariants pass.
- Check validator output for: copilot-loop-state, reviewer-loop, conductor-routing, pr-gate-coordination, public-dev-loop-routing

**AC4**: No RFC-2119 contradiction in corpus.
- Quick spot-check of modality-conflict scan

**AC5**: Total corpus word count reduced with zero information loss.
- Compute wc -w at baseline (8cda46da) vs HEAD over all contract docs (skills/docs, skills/*/SKILL.md, docs, agents, commands)

**AC6**: Zero regressions - every child PR merged green.
- Check PR merge history

**DoD1**: All sub-issues #1147-#1159 closed via merged, gated PRs.
**DoD2**: Required-rules manifest covers corpus; validate-no-duplicate-rules.mjs retired or subsumed.
**DoD3**: Word-count roll-up and final validator/harness status posted as closing comment.
- Check if closing comment exists on #1104

**Context**: This is audit scope 6 of the v0.8 release gate contract audit (#1192). Epic is #1104.

---
**Output:**
Write your findings to exactly this path: /Users/mfittko/github/dev-loops/.pi-subagents/artifacts/outputs/363fd6c8/tmp/audits/claude-sonnet-4/scope-6-epic-closeout.md
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