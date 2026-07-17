# Task for reviewer

[Read from: /Users/mfittko/github/dev-loops/plan.md, /Users/mfittko/github/dev-loops/progress.md]

INDEPENDENT CONTRACT AUDIT — Scope item 3 of issue #1192 (v0.8 release gate). You have NO prior context from the epic #1104 batch PRs. Be a fresh reviewer.

Repo: /Users/mfittko/github/dev-loops (cwd). Read-only review. Do NOT mutate repo files. Write ONLY to tmp/audits/GLM-5.2-FP8/review/03-contradiction-scan.md.

TASK — RFC-2119 contradiction scan across the entire rule registry:
1. Read skills/docs/required-rules.json (the rule registry/manifest) and skills/docs/contract-style-guide.md (modality + contradiction discipline).
2. Enumerate every rule across the corpus (rules are tagged `<!-- rule: ID -->` before their clause in skills/docs/*.md, docs/*.md, skills/*/SKILL.md, agents/*.md, commands/*.md). Use: grep -rn '<!-- rule:' across those roots.
3. For EACH rule, extract its RFC-2119 modality (MUST / MUST NOT / SHALL / SHALL NOT / SHOULD / MAY) and its behavior/guard/precondition.
4. Detect contradictions:
   - MUST vs MUST NOT on the same behavior (same subject + predicate, opposing modality).
   - Conflicting guards/preconditions across rules that gate the same transition/operation.
   - Modality downgrades: a rule elsewhere weakening a MUST to SHOULD/MAY on the same behavior.
   - Same-behavior rules stated in two owner docs (ownership violation is also a contradiction-in-source).
5. The deterministic modality-conflict scan lives in scripts/docs/validate-rule-ownership.mjs (already green at HEAD) — your job is the SEMANTIC pass it cannot do: read the actual prose, not just tokens.

DELIVERABLE (write to the output file):
- Header: '# Scope 3 — RFC-2119 contradiction scan (independent)'
- A verdict line: PASS or FAIL (FAIL = any blocking contradiction found).
- A numbered findings table: | # | Rule IDs | Location(s) | Conflict type | Evidence (quoted prose) | Severity (blocker/waiver/nit) |
- If zero findings, state explicitly: 'Zero RFC-2119 contradictions found across N rules reviewed.'
- Footer: rule count reviewed, files scanned, method note.

Keep it tight. Quote exact prose. No essays.

---
**Output:**
Write your findings to exactly this path: /Users/mfittko/github/dev-loops/.pi-subagents/artifacts/outputs/57fd60b8/tmp/audits/GLM-5.2-FP8/review/03-contradiction-scan.md
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