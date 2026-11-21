# 0307. Gate angle prompts render the developer checklist from one config entry

## Status

Accepted — 2026-11-21 ([issue 3396](https://github.com/mfittko/dev-loops/issues/3396))

Extends: 0304 ([record](./0304-developer-pre-pr-self-check.md)). ADR 0304 states a checklist cap of 14. This record raises the cap to 19, counted after merging ADR 0310 (line C4).

## Context

Copilot threads show classes of defect that both the developer and the draft_gate fan-out missed. Issue 3395 gave the developer a `developer-checklist` per angle in `gates.draft.angles`. The gate angle prompts held separate text, so the developer and the gate could drift apart.

A matcher class gets a new checklist line when it holds at least 10% of the Copilot-only threads. The basis is the `byClass` output of the matcher run over the 110 threads, posted on issue 3396 ([report](https://github.com/mfittko/dev-loops/issues/3396#issuecomment-7062600555)). It found 14 Copilot-only threads: other 9 (64%), tests 3 (21%) and input-validation-edge-case 2 (14%). The matcher matches by file only, so these counts are a lower bound. All three classes pass the 10% share. The input-validation-edge-case class maps to the I2 line, which now lists the quoting, continuation, substitution, abbreviation, nesting and case forms. The docs-help-description class holds 0 Copilot-only threads, under the share, so it gets no checklist id. Two small texts stay because they add no id and no checklist item: the CS1 detail on exit-code tables and the pr-description heading line. Both rest on the 22 keyword matches in the issue body, a count that includes threads a gate finding also caught. The tests class maps to no new line and is listed on issue 3396 ([listing](https://github.com/mfittko/dev-loops/issues/3396#issuecomment-7066998705)) with the existing `coverage` angle as its proposed home. The `other` class maps to the A3, A4, A6 and A8 lines and to the downstream-reader detail merged into K2. A line that restated an existing line of the same angle (producer and consumer parity, claims, packaging) was merged into that line instead of getting its own id.

## Decision

- `resolveReviewerRole` appends the `developer-checklist` lines of the angle entry to the angle prompt. The developer brief reads the same lines. The `developer-checklist` entry is the one source for both renderings.
- Lines A3, A4, A6 and A8, with detail merged into CS1, I2 and K2, cover the Copilot-only classes: producer and consumer parity, alternate input forms, artifact staleness, refusal remedies, restated claims, execution context and instruction contradictions. PK1 already covers packaging and cross-harness text. Each line is one bounded sentence of at most 200 characters, and an angle carries at most 4 lines.
- The pr-description prompt names the template headings Objective and In scope.

## Consequences

- The developer brief carries at most 19 checklist items with the shipped defaults.
- A new checklist line reaches both the developer and the gate reviewer without a second edit.
