# 0303. The developer applies past gate finding classes as constraints while writing

## Status

Accepted — 2026-11-21 ([issue 3395](https://github.com/mfittko/dev-loops/issues/3395))

Extends: 0139 ([record](./0139-pr-create-pre-pr-review-record-guard.md)) and 0159 ([record](./0159-pre-pr-review-runs-stale-surface-sweep.md)). Both records stay unedited.

## Context

The first draft_gate round repeatedly finds the same classes of defect: missing tests for a failure path, a PR body out of sync with the code, stale help or docs, and unhandled edge cases. Copilot threads, which arrive after a clean gate, repeat the edge-case and input-validation class. The developer received no input that named these classes or the reviewer angles before it wrote code.

## Decision

- `dev-loops gate finding-classes` reads the durable findings logs offline and reports the top angles of act-judged findings from the first draft_gate round of each PR. From an optional local export file (`--copilot-file`, JSONL) it adds `copilotClasses`, bucketed by keyword. It makes no GitHub call.
- `loop implementation-brief` carries a `selfCheck` object, bounded in size: one condensed constraint line (the first sentence of the angle prompt, at most 200 characters, at most 8 angles) per draft_gate angle that applies to the touched paths, the top 3 gate classes, the top 3 Copilot classes (one example each) and the checklist items: the 14 `developer-checklist` lines (ids `C1` to `PK1`) stored per angle under `gates.draft.angles` in the shipped config, the single source, in config order (`P2`, `CS1` and `CS2` carry `finalStep: true`, the last writing step before hand-back). The developer applies the constraints while it writes each change.
- The record writer requires `--self-check-file` in record mode: a JSON array of `{ id, status, evidence }` that covers the angle ids resolved for the `base...HEAD` changed paths plus the checklist ids, with non-empty evidence. The shared id derivation lives in a leaf module, so the writer does not import the brief. The writer refuses with `pre_pr_self_check_missing` and stores the entries in the record (`PRE-PR-DEVELOPER-SELF-CHECK`).
- The record `integrity` digest and the `pr create` validation stay unchanged. The record is not gate evidence (`PRE-PR-NOT-GATE-EVIDENCE`).

## Non-goals

- A post-implementation self-review pass. The record states what the developer did while writing.
- Changing the reviewer angles or the judge.

## Consequences

The developer sees the reviewer angles and the most frequent finding classes before it writes code, and the per-angle evidence is stored with the record. The record command gains a required flag, so callers of the writer pass it in record mode. The evidence is self-reported and the gate stays the authority. Without findings logs or an export, the brief carries the angles and the checklist items and nothing blocks.
