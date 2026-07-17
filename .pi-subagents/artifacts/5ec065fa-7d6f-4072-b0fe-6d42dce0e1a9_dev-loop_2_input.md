# Task for dev-loop

Re-run pre_approval_gate as true fan-out/fan-in for issue #1035 / PR #1079, repo mfittko/dev-loops. Then merge IF gate-complete.

Inputs: issue=1035, pr=1079, head=5d8833e9 (current). Prior run posted pre_approval_gate verdict clean but executionMode=inline_single_agent — rejected by requireFanoutEvidence. draft_gate clean fanout_fanin (satisfied). Copilot rounds 2/2 cap reached, 0 unresolved threads, CI success, mergeStateStatus CLEAN.

Authorization: HUMAN MERGE AUTHORIZED CONDITIONAL ON GATE-COMPLETE. Re-run the pre_approval_gate with true fan-out/fan-in. If the re-run is clean fanout_fanin AND preMergeGateCheck ok:true AND retro gate satisfied → merge (squash). If any precondition fails → STOP and report, do not force, do not bypass.

Why this run: the prior parallel-batch dev-loop subagent had no subagent fan-out tool, so it ran the gate inline. This is a top-level dispatch — fan-out must be available. If fan-out is STILL unavailable, STOP immediately and report (do not run another inline gate).

Procedure:
1. Resolve dev-loops package root via bounded candidates (node module resolution → ~/.pi/agent/npm/node_modules/dev-loops → package-relative → global). Never unbounded find.
2. Worktree cwd (mandatory): fetch origin, use a worktree checkout for git/file/validation ops — never the main checkout.
3. Load copilot-pr-followup skill + copilot-loop-operations + final-approval skill.
4. Re-run pre_approval_gate on current head 5d8833e9 as fanout_fanin: build gate context, run dynamic angle resolution, dispatch one review subagent per resolved angle (parallel fan-out), collect findings, consolidate via consolidateFanin, write findings-log ledger, post verdict via upsert-checkpoint-verdict.mjs with --execution-mode fanout_fanin. Cover mandatory angles (pr-checklist-matrix, acceptance-criteria) plus dynamically resolved ones. The prior inline review found the diff clean (shared _resolve-project.mjs extraction consumed by add-queue-item + list-queue-items); expected clean.
5. Verify preMergeGateCheck ok:true via detect-checkpoint-evidence.mjs.
6. Retrospective merge gate (requireRetrospectiveGate:true, requireRetrospectiveInternalTooling:true): satisfy a fresh retro checkpoint for THIS PR (complete + mergeApproved:true + internalToolingOnly:true + empty rawCallViolations) before merging. The existing checkpoint records PR #1073 — not applicable. If the retro gate cannot be satisfied cleanly, STOP and report — do not bypass.
7. If steps 4-6 all clean → execute merge via the final-approval sanctioned path (squash). Use the dev-loops merge wrapper if one exists; otherwise the final-approval skill's merge procedure.
8. If any precondition failed → STOP, leave PR unmerged, report the blocking condition and the smallest next step.
9. Report back: gate executionMode (must be fanout_fanin), verdict, preMergeGateCheck result, retro-gate outcome, merge verdict + SHA (if merged) or the blocking condition (if not).

---
**Output:**
Write your findings to exactly this path: /Users/mfittko/github/dev-loops/.pi-subagents/artifacts/outputs/5ec065fa-7d6f-4072-b0fe-6d42dce0e1a9/tmp/dev-loop-runs/pr-1079-gatererun.out.md
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