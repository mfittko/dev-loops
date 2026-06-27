# Process Observability deck — designer/vision review notes

Slice: `observability-deck` · artifacts under
`test-results/ui-smoke/observability-deck/named-states/<state>/`.

## Review brief

Judge the render against the deck identity (dark glass-card, violet accent,
blue kicker, mono pills): legible hierarchy, no overflow/clipping, the inline
flow diagrams readable, cards consistent across rows, and the close landing as
a punchline rather than a stray paragraph.

## Storytelling pass (public, non-insider audience)

The pre-refresh deck was already public-leaning, but it read as a sequence of
*topics* rather than a story: topic-style titles (`Delay pattern`,
`Observable state`, `Visibility → measurement → automation`), a hero with a
`task state` / `pipeline latency` jargon pill wall, two near-duplicate
handoff-cost slides, and a close that was a bare three-metric grid with no
memorable line. The abstract "observable state cuts delay" claim was never tied
to anything that actually exists.

### Findings (covered all slides)

- **Hero** stated a symptom ("Work stalls between actions") rather than a hook a
  stranger feels; the pill row leaned on insider terms.
- **Handoff slides** (old "Every handoff forces a discovery round" + "Thin state
  stalls every actor") overlapped — two slides making one point.
- **Titles were topics, not claims** throughout (e.g. "Explicit state turns
  pickup into continuation" was the strongest, but most were bare nouns).
- **The "observable state" promise floated free** — four fields were asserted as
  valuable but never grounded in any real mechanism.
- **Close** ("Visibility → measurement → automation" bullet list) restated the
  body with no emotional landing.

### Corrective actions applied

Rewrote both `process-observability-presentation.md` (Slidev) and
`process-observability.html` to one 9-slide claim-titled arc, one message per
slide, jargon translated to plain language, and a grounding slide added:

1. `hero` — pain hook: "AI Writes the Code in Seconds. Then the Work Sits for
   Hours." Pills trimmed to wait states / handoff cost / coordination delay.
2. `interrupt-cost` — "One Interrupt Costs Five Transitions, Not Five Minutes"
   (the 5-step flow kept as inline diagram).
3. `handoff` — "Every Handoff Restarts the Same Discovery From Scratch"; merged
   the two old handoff/mixed-actor slides into one two-card slide.
4. `blind-spot` — "Your Git History Hides Exactly Where the Time Went."
5. `observable-state` — "Four Fields Decide Whether the Next Actor Starts or
   Stalls" (owner / blocker / latest decision / safe next step).
6. `measurement-loop` — "You Can't Shorten a Wait You Never Measured" (the
   measure→change→verify loop diagram kept, now a closed cycle).
7. `instrumented` — **new grounding slide**: "Those Four Fields Aren't a Wish —
   They're Where the Work Already Lives." Ties the framing to the queue board
   lifecycle (owner/next step), the gate evidence trail (latest decision), the
   deterministic next-action resolver, and provider-agnostic CI waits +
   post-merge reclaim/archive ("automate only where state supports safe
   continuation") — in plain language, no version labels or raw identifiers.
8. `metrics` — "Visible State Moves Three Numbers at Once" (quality / waiting /
   throughput kept).
9. `close` — "The Cheapest Speed-Up Is Making the Waiting Visible" with a
   one-line punchline closer: *"Stop optimizing how fast you write code. Start
   measuring how long it waits."*

The visual identity (dark glass-card classes / inline CSS, ported from
`style.css` exactly as `applied-dev-loops.html` does) is unchanged — content,
structure, and grounding only.

## Visual pass — designer/vision review

Captured the named states via `npm run test:playwright:obs-deck`
(WebKit): `hero`, `interrupt-cost` (delay pattern), `observable-state`,
`measurement-loop`, `instrumented`, `metrics`, `close`. Each
`screenshot.png` was opened and critiqued; a 390px-wide pass confirmed the
responsive collapse (no horizontal overflow).

### Findings (per captured state)

- **hero** — solid. Single hero-card, clear title/sub/pill hierarchy, mono pills
  read as intended. No change.
- **observable-state** — two cards share one height (grid `align-items:
  stretch`); the lead-paragraph left card and the four-field right card balance.
  Flow/diagram-free, fully legible. No change.
- **instrumented** — the new three-card grounding slide: cards are equal height,
  hierarchy clean, each card reads as one mechanism without identifier walls. No
  change.
- **metrics** — three equal-height cards, consistent labels, no clipping. No
  change.
- **close** — the `metric-card` `.closer` lands the punchline centered, larger,
  accent-soft; left list card and closer card share one height. The close reads
  as a closer, not a stray paragraph. No change.

### Outcome

The look ports cleanly from the applied deck's proven CSS: equal-height grid
rows, capped measure on the full-width `blind-spot` card (`.card-narrow`),
centered flow cards, and the `.closer` punchline style were all carried over, so
the defects the applied deck's review found (ragged card bottoms, edge-to-edge
measure, stranded diagrams, a flat close) do not recur here. No corrective CSS
beyond the ported baseline was required. No horizontal body overflow at desktop
or 390px. Playwright obs-deck spec passes (all named sections present, 7 states
captured).

Result: `ui_review_satisfied`.
