# 0307. Gate angle prompts render the developer checklist from one config entry

## Status

Accepted — 2026-11-21 ([issue 3396](https://github.com/mfittko/dev-loops/issues/3396))

Extends: 0304 ([record](./0304-developer-pre-pr-self-check.md)). The record stays unedited in meaning; only its item cap changes from 14 to 22.

## Context

Copilot threads show classes of defect that both the developer and the draft_gate fan-out missed. Issue 3395 gave the developer a `developer-checklist` per angle in `gates.draft.angles`. The gate angle prompts held separate text, so the developer and the gate could drift apart.

## Decision

- `resolveReviewerRole` appends the `developer-checklist` lines of the angle entry to the angle prompt. The developer brief reads the same lines. The `developer-checklist` entry is the one source for both renderings.
- Lines A1 to A8 cover the Copilot-only classes: producer and consumer parity, alternate input forms, artifact staleness, refusal remedies, restated claims, execution context, packaging and cross-harness text, and instruction contradictions. Each line is one bounded sentence of at most 200 characters, and an angle carries at most 4 lines.
- The preApproval `holistic` and `contradiction-lens` entries alias the draft checklist through a YAML anchor.
- The pr-description prompt names the template headings Objective and In scope.

## Consequences

- The developer brief carries at most 22 checklist items with the shipped defaults.
- A new checklist line reaches both the developer and the gate reviewer without a second edit.
