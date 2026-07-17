# Task for reviewer

[Read from: /Users/mfittko/github/dev-loops/plan.md, /Users/mfittko/github/dev-loops/progress.md]

INDEPENDENT CONTRACT AUDIT — Scope item 6 of issue #1192 (v0.8 release gate). Fresh reviewer.

Repo: /Users/mfittko/github/dev-loops (cwd). Read-only. Write ONLY to tmp/audits/GLM-5.2-FP8/review/06-epic-closeout.md.

TASK — Verify epic #1104 closeout: AC1–AC6 and DoD1–DoD3.
1. Fetch the epic body: `gh issue view 1104 --repo mfittko/dev-loops`. Extract the full Acceptance Criteria (AC1–AC6) and Definition of Done (DoD1–DoD3) lists verbatim.
2. For EACH AC and DoD, verify it against the actual repo state at HEAD. Evidence-based:
   - AC1 (rule ownership + required-rules manifest): check scripts/docs/validate-rule-ownership.mjs passes (run: node scripts/docs/validate-rule-ownership.mjs) and skills/docs/required-rules.json covers the corpus. The mechanical audit already logged this green at tmp/audits/GLM-5.2-FP8/mechanical/01-rule-ownership.log — you may cite it.
   - AC3 (L2/L3 conformance): cite tmp/audits/GLM-5.2-FP8/mechanical/02-state-machine-conformance.log (4 machines PASS).
   - AC2 (phrase-pin zero-state): cite tmp/audits/GLM-5.2-FP8/mechanical/ findings (0 exact-sentence pins in test/contracts).
   - AC4 (deterministic modality-conflict scan gating): check scripts/docs/validate-rule-ownership.mjs runs the contradiction scan and that it is gating (not advisory). Read #1159 intent. Cross-reference scope 3 (tmp/audits/GLM-5.2-FP8/review/03-contradiction-scan.md if present).
   - AC5 (total corpus word count reduced): cite the roll-up at tmp/audits/GLM-5.2-FP8/mechanical/07ab-wordcount-rollup.md — NOTE the net +710 words and that scope 7d adjudicates whether AC5 is genuinely met.
   - AC6 and any DoD about word-count roll-up posted, validator/harness status: state what is posted where.
3. Also confirm the epic's sub-issue tree (#1147–#1159) is fully closed: `gh issue list --repo mfittko/dev-loops --state open --search 'milestone:v0.8'` and check each sub-issue state.

DELIVERABLE: write to output file:
- Header '# Scope 6 — Epic #1104 closeout verification (independent)'
- A table: | Item | Text (verbatim) | Met? (YES/NO/PARTIAL) | Evidence |
- A sub-issue tree closeout table: | Sub-issue | State | Linked PR |
- A verdict line: EPIC READY TO CLOSE? YES/NO.
- Note any AC that is NOT met and what remains.

Keep evidence concrete (commands run, file paths, exit codes).

---
**Output:**
Write your findings to exactly this path: /Users/mfittko/github/dev-loops/.pi-subagents/artifacts/outputs/57fd60b8/tmp/audits/GLM-5.2-FP8/review/06-epic-closeout.md
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