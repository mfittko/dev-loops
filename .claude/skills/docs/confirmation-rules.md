# Confirmation rules

Canonical owner for agent confirmation / authorization rules across all workflow families.

## Core rule

<!-- rule: CONFIRM-CORE-EXPLICIT -->
`CONFIRM-CORE-EXPLICIT`: Before any state-changing action, the agent MUST obtain explicit confirmation unless the latest user message already clearly authorizes that exact action.

## What counts as confirmation

- ✅ Explicit authorization in the current conversation
- ✅ Pre-authorized merge or mutation scope (e.g. "Merge authorized if gates green")
- ❌ Questions, preferences, future-tense statements
- ❌ Implied approval from prior turns
- ❌ Bare response `ok`

## Where this rule applies

- All routed strategies (`local_implementation`, `copilot_pr_followup`, `issue_intake`, `reviewer_fixer`, `final_approval`)
- All gate entries (`draft_gate`, `pre_approval_gate`)
- All merge operations
- All force-push / history-rewriting operations

## Cross-references

- [Stop conditions](stop-conditions.md)
- [Merge preconditions](merge-preconditions.md)
- [Public Dev Loop Contract](public-dev-loop-contract.md)
