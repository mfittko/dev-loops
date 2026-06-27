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
| v040-capabilities | Three cards had **ragged bottoms** (unequal heights in the row) — looks unpolished against the deck identity. | `named-states/v0-4-0-capabilities/screenshot.png` |
| impact | Same ragged-bottom issue on the three metric cards. | `named-states/impact/screenshot.png` |

## Corrective actions applied

- Grid rows now `align-items: stretch` and grid card children are flex columns, so
  glass/metric cards in a row share one height and bottoms align.

## Pass 2

Re-captured all four states. Card bottoms align across rows; hierarchy, accent
colours, and the inline flow remain consistent. No horizontal body overflow.

Outcome: `ui_review_satisfied`.

## Storytelling pass (public, non-insider audience)

Reviewed all 12 slides of the v0.4.0 deck for narrative, not visuals. The deck
read as an accurate insider walkthrough of the state machine but had no story
arc for a stranger: topic-style titles (not claims), one jargon enum or pill
wall per slide, mechanism stated before the pain it solves, and the close was a
bare feature grid with no mechanism→outcome link.

### Findings (covered all slides)

- **Hero** sold the mechanism ("coordination runtime built on nested state
  machines"), not the stranger's pain.
- **Slides 2–11** carried raw identifiers as content: `ROUTING_OUTCOME`,
  `SAFE_POINT_CATEGORY`, `STEERING_KIND`, the five steering result enums,
  `consolidateFanin` / `fanout_fanin` / "1-hop adjacency" / "no fork primitive".
  These are implementation trivia for a public audience.
- **Redundancy:** loop model (3) + conductor routing (5) both said "one outcome
  per cycle"; parallel reviews (6) + gate fan-out (9) both described fan-out /
  fan-in; quality gates (4) + PR lifecycle (8) both described fail-closed gates.
- **Why-graphs (slide 2)** was the strongest payoff but buried near the front.
- **Trust / never-lie (slide 10)** — the human-merge, real-`done`, verified-CI
  guarantees — was the most relatable point but under-emphasised mid-deck.
- **Close (slide 12)** was a Quality/Wait/Throughput grid with no link from
  mechanism to outcome and no memorable closing line.

### Corrective actions applied

Rewrote both `applied-dev-loops-presentation.md` (Slidev) and
`applied-dev-loops.html` to one ~8-slide arc, claim-style titles, one message
each, jargon translated to plain language, at most one identifier per slide as
evidence. The visual identity (dark glass-card classes / inline CSS) is
unchanged — content/structure only.

New arc and section ids:

1. `hero` — pain (leaked time in handoffs), not the mechanism.
2. `core-idea` — merged old 3 + 5; three loops translated to roles; "ambiguity
   never becomes a guess" kept.
3. `safe-pauses` — merged old 4 + the fail-closed half of old 8; safe-point
   categories in plain words; one example, not four arrows.
4. `steering` — old 7; kinds translated; concrete "don't touch the auth module"
   example; five result enums cut.
5. `parallel-review` — merged old 6 + 9; same-evidence/one-verdict; cut
   `consolidateFanin` / `fanout_fanin` / "1-hop adjacency" / "no fork primitive".
6. `trust` — old 10 promoted; human-merge / real-`done` / verified-CI in plain
   language.
7. `why-graphs` — old 2 moved here as the payoff; one closed/enumerable bullet.
8. `impact` — old 12 grounded as mechanism→outcome links + one closing line.

Playwright named states updated to the new ids (`hero`, `core-idea`,
`parallel-review`, `trust`, `impact`); no-horizontal-overflow assertion kept.

---

## Visual refinement pass — post-restructure designer review (issue-926)

Visual-only pass over the rewritten 8-slide deck. Narrative content unchanged;
section ids stable. Captured all eight named states via
`npm run test:playwright:deck` (WebKit) — the spec's `NAMED_STATES` was widened
from 5 to all 8 ids (`hero`, `core-idea`, `safe-pauses`, `steering`,
`parallel-review`, `trust`, `why-graphs`, `impact`) and kept widened for
broader future coverage. Each `screenshot.png` was opened and critiqued; a
390px-wide pass confirmed the responsive collapse (no horizontal overflow).

### Findings (per slide)

- **hero** — solid. Balanced single hero-card, good hierarchy. No change.
- **core-idea** — flow card's diagram sat top-aligned, leaving dead space
  below it against the taller left list card. Diagram looked stranded.
- **safe-pauses / steering / trust** — vertical position varies between
  captures, but that is a `scrollIntoViewIfNeeded` capture artifact (each
  `.slide` is `min-height:100vh; justify-content:center` in the real deck), not
  a layout defect. Content, spacing, and card balance are correct. No change.
- **parallel-review** — flow diagram legible, aligned, centered; cards balanced.
  Same flow-card centering tweak applied for consistency. Otherwise solid.
- **why-graphs** — real readability defect: the single full-width `.glass-card`
  let body lines run the full ~72rem inner width (~110ch), too wide to read
  comfortably.
- **impact** — the `metric-card` closing line read like a stray left-aligned,
  top-anchored paragraph rather than a closer; it did not land as a punchline,
  and the card had dead space below it.

### Corrective actions applied (CSS/markup only, self-contained, CSP-safe)

- `.card-narrow` (max-width 58rem, left-anchored under the title) on the
  why-graphs card — caps the measure for a readable line length without
  detaching from the left-aligned heading.
- `.closer` on the impact metric-card — vertically centers the line and styles
  `.hero-copy` inside it centered, larger, weighted, accent-soft: it now lands
  as the deck's closing punchline.
- `.flow-card` on the core-idea and parallel-review diagram cards —
  `justify-content: center` so the diagram is vertically centered against the
  taller adjacent list card instead of stranded at the top.

Kept the navy/glass/violet identity, inline styles, and all section ids.

### Before / after

Before: why-graphs lines ran edge-to-edge (hard to read); impact closer was a
left/top paragraph; core-idea & parallel-review diagrams hung at card top.
After (re-captured + re-read): why-graphs reads at a comfortable measure under
its title; the impact closer is centered and emphatic; both flow diagrams sit
centered in their cards. Narrow (390px) collapse verified — single column, no
horizontal overflow. Playwright deck spec passes (8 states captured).
