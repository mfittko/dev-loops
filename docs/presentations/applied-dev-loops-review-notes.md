# Applied dev-loops deck — designer/vision review notes

Slice: `applied-deck` · artifacts under `test-results/ui-smoke/applied-deck/named-states/<state>/`.

## Review brief

Judge the v0.4.0 deck render against the deck identity (dark glass-card, violet
accent, blue kicker): legible hierarchy, no overflow/clipping, the inline
fan-out/fan-in flow readable, cards consistent across rows.

## Pass 1 findings

| State | Finding | Evidence |
| --- | --- | --- |
| hero | Hierarchy clean, no issues. | `named-states/hero/screenshot.png` |
| gate-fanout | Inline flow (boxes + arrows) legible; cards fit; no clipping. | `named-states/gate-fan-out/screenshot.png` |
| v0.4.0-capabilities | Three cards had **ragged bottoms** (unequal heights in the row) — looks unpolished against the deck identity. | `named-states/v0-4-0-capabilities/screenshot.png` |
| impact | Same ragged-bottom issue on the three metric cards. | `named-states/impact/screenshot.png` |

## Corrective actions applied

- Grid rows now `align-items: stretch` and grid card children are flex columns, so
  glass/metric cards in a row share one height and bottoms align.

## Pass 2

Re-captured all four states. Card bottoms align across rows; hierarchy, accent
colours, and the inline flow remain consistent. No horizontal body overflow.

Outcome: `ui_review_satisfied`.
