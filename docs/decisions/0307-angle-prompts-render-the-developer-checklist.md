# 0307. Gate angle prompts render the developer checklist from one config entry

## Status

Accepted — 2026-11-21 ([issue 3396](https://github.com/mfittko/dev-loops/issues/3396))

Extends: 0304 ([record](./0304-developer-pre-pr-self-check.md)). ADR 0304 states a checklist cap of 14. This record raises the cap to 22.

## Context

Copilot threads show classes of defect that both the developer and the draft_gate fan-out missed. Issue 3395 gave the developer a `developer-checklist` per angle in `gates.draft.angles`. The gate angle prompts held separate text, so the developer and the gate could drift apart.

A matcher class gets a new checklist line when it holds at least 10% of the Copilot threads in the issue baseline (11 of 110). Three classes pass: edge-case-input-validation (39) maps to A2, docs-help-description (22) maps to A5 and the pr-description heading line, and tests (18) maps to no new A line. The tests class is listed on issue 3396 with the existing `coverage` angle as its proposed home. The `other` class is the rest of A1, A3, A4, A6, A7 and A8.

## Decision

- `resolveReviewerRole` appends the `developer-checklist` lines of the angle entry to the angle prompt. The developer brief reads the same lines. The `developer-checklist` entry is the one source for both renderings.
- Lines A1 to A8 cover the Copilot-only classes: producer and consumer parity, alternate input forms, artifact staleness, refusal remedies, restated claims, execution context, packaging and cross-harness text, and instruction contradictions. Each line is one bounded sentence of at most 200 characters, and an angle carries at most 4 lines.
- The preApproval `holistic` and `contradiction-lens` entries alias the draft checklist through a YAML anchor.
- The pr-description prompt names the template headings Objective and In scope.

## Consequences

- The developer brief carries at most 22 checklist items with the shipped defaults.
- A new checklist line reaches both the developer and the gate reviewer without a second edit.
