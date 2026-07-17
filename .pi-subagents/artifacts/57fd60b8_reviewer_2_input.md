# Task for reviewer

[Read from: /Users/mfittko/github/dev-loops/plan.md, /Users/mfittko/github/dev-loops/progress.md]

INDEPENDENT CONTRACT AUDIT — Scope item 7c/7d of issue #1192 (v0.8 release gate). Fresh reviewer.

Repo: /Users/mfittko/github/dev-loops (cwd). Read-only. Write ONLY to tmp/audits/GLM-5.2-FP8/review/07cd-semantic-dedup.md.

CONTEXT: The mechanical word/line roll-up (scope 7a/7b) is already computed and lives at tmp/audits/GLM-5.2-FP8/mechanical/07ab-wordcount-rollup.md — READ IT FIRST. Totals at pre-epic baseline (8cda46da) vs HEAD: baseline 99,734 words / 11,969 lines → HEAD 100,444 words / 12,073 lines = NET +710 words / +104 lines. Epic #1104 AC5 promised 'total corpus word count reduced with zero information loss'. The mechanical lens shows net-POSITIVE. Your job is the SEMANTIC pass the lexical near-dup scan cannot do, plus the condensation-candidates list.

TASK:
1. Read the roll-up file to see per-doc deltas and which docs grew.
2. Read skills/docs/required-rules.json and contract-style-guide.md for the ownership model.
3. SEMANTIC DEDUP PASS (7c) — find same-behavior content stated more than once, which a lexical scanner misses:
   a. Same-behavior rules across families phrased differently (e.g. a stop-conditions rule restated in a SKILL.md or docs/*.md with different wording).
   b. Procedures restated as prose around a rule that already owns them (a doc narrates the steps of a behavior a rule-ID-owning doc already defines).
   c. Elaboration bullets / orientation paragraphs that repeat the rule line itself.
   d. The 'one short orientation paragraph that introduces no rules is allowed per doc' exception — flag any orientation paragraph that actually restates a rule.
4. GROWTH ATTRIBUTION (7b semantic overlay) — for the docs that grew most (reviewer-loop-state-graph, gate-review-sub-loop-contract, contract-style-guide, stop-conditions, conductor-routing-contract), classify the added lines: (i) machine annotation / rule-ID marker lines, (ii) genuinely new normative prose, (iii) residual verbosity. Give rough percentages per top-growing doc.
5. CONDENSATION CANDIDATES (7d) — ranked list with expected word savings. Every candidate worth >~50 words becomes a filed `pre-v0.8` condensation issue (zero semantic change) unless waived here with rationale. Use the format:
   | Rank | Location (path + rule/section) | What to condense | Expected word savings | Semantic change? (must be NO) | Waive? (Y/N + reason) |
6. VERDICT on epic AC5: is 'total corpus word count reduced with zero information loss' genuinely met against the pre-epic baseline? State YES/NO with the numbers.

DELIVERABLE: write the full report to the output file with header '# Scope 7c/7d — Semantic dedup + condensation lens (independent)', the AC5 verdict up top, then the dedup findings, growth attribution, and the ranked candidates table. Be concrete with paths and quoted prose.

---
**Output:**
Write your findings to exactly this path: /Users/mfittko/github/dev-loops/.pi-subagents/artifacts/outputs/57fd60b8/tmp/audits/GLM-5.2-FP8/review/07cd-semantic-dedup.md
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