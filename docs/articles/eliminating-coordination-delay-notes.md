# Editorial / storytelling review — "Eliminating Coordination Delay in AI-Assisted Dev Workflows"

One storytelling review pass over `docs/articles/eliminating-coordination-delay.md`, using the prose-adapted lens from [`../slides-story-review-loop.md`](../slides-story-review-loop.md): hook, one idea per section, public-audience clarity, arc, strong close, and diagrams that earn their place.

## Storytelling brief

- **Audience:** public / non-insider developers and technical leads. No prior knowledge of the runtime.
- **Intended takeaway:** AI made code cheap; coordination is now the cost; the fix is to make every handoff an explicit, observable decision on a state graph.
- **Pay extra attention to:** no version-pegging, no raw enum/identifier dumps, a hook a stranger cares about, one idea per section, and a close that is a line, not a feature list.

## Findings and corrective actions (applied)

| # | Severity | Finding | Corrective action | Status |
|---|----------|---------|-------------------|--------|
| 1 | high | First draft risked opening on the mechanism ("nested loops") before the reader cares. The hook must make a stranger feel the pain first. | Open on the concrete asymmetry — code writes in seconds, the handoffs around it leak hours and get guessed wrong — and name "coordination delay" in plain language before any mechanism. | Done |
| 2 | high | Source deck carried raw identifiers (`stop_at_next_safe_gate`, `hard_constraint`, `fanout_fanin`, `humanMergeOnly`). A public reader does not need them and they date the piece. | Translated every identifier to plain language ("a tidy stopping point", "a hard constraint", "one consolidated verdict", "a named human"). No raw enums or config keys in the article. | Done |
| 3 | medium | "What it buys" risked becoming a flat feature list — the deck's failure mode for a close, and a real risk for a body section too. | Framed the four behaviors as things a *guess-based* workflow cannot offer, each as its own bolded one-idea beat (safe pauses, steering, parallel review, honest done), with "done means merged" called out as the one that matters most. | Done |
| 4 | medium | Four diagrams must each earn their place, not decorate. Two (lifecycle, fan-in) were already in the deck; two (PR-gate flow as a flowchart, steering flow) are new and must add information the prose doesn't. | Each diagram gets a caption stating what it shows that the text does not: the gate flow shows the loop-backs (can't skip a gate that didn't run); the steering flow shows the apply-now-vs-queue-until-safe branch. Removed any diagram that only restated a sentence. | Done |
| 5 | medium | "Why a state graph beats a prompt" is the intellectual core but was buried as a bullet list in the source. As prose it needs a memorable contrast, not a list. | Rewrote as a two-consequence argument ending on the line "A prompt is a wish about behavior. A state graph is a guarantee about it." | Done |
| 6 | low | Close risked trailing off after the state-graph section. Decks taught: end on a line, not a recap. | Added a short dedicated close that restates the arc in two sentences and lands on the deck's punchline: "Make every handoff a decision you can see, and nothing stalls in the dark." | Done |
| 7 | low | Medium can't render Mermaid; without guidance the diagrams would break for the actual publish target. | Added a "Rendering the diagrams on Medium" note and ensured every diagram is captioned so the prose carries the argument even when diagrams are static images. | Done |

## Lens check

- **Hook:** opens on the felt pain (cheap code, leaky handoffs, wrong guesses), names the cost. ✔
- **One idea per section:** the one idea (never guess a handoff) is stated once and each later section is a single beat. ✔
- **Public clarity:** no version numbers, no raw enums/config keys; mechanism named in plain language. ✔
- **Arc:** hook → one idea → what it buys → fan-out/fan-in → steering → why a graph → close. ✔
- **Strong close:** a line, not a feature list. ✔
- **Diagrams earn their place:** 4 captioned diagrams, each adding structure the prose states only in passing. ✔

## Outcome

`story_review_satisfied` — remaining nits are minor and do not justify another dedicated pass.

## Deslop pass

Applied the deslop ruleset to the prose in both `eliminating-coordination-delay.md` and its render `eliminating-coordination-delay.html`, keeping meaning, structure, the 4 diagrams and their captions, the front-matter, and the dark visual identity. Tells removed:

- **Em-dashes in prose:** replaced with commas, periods, or parentheses. Markdown body dropped from 22 to 4 (the 4 remaining are the `Diagram N —` caption labels, kept as a caption convention); HTML `&mdash;` dropped from 31 to 4 (same caption labels).
- **Binary-contrast fragments:** "The code is cheap now. The coordination is not." → "Code is cheap to write now; getting it through the pipeline is not." And "That sounds modest. It is not." → "That sounds modest, but most of the lost hours...".
- **Dramatic short fragments:** dropped "Many eyes, one decision." and "Same input, parallel angles, one output you can trust." (the latter rewritten into a full sentence).
- **Magic adverbs:** "quietly guess wrong" → "guess wrong"; "It drifts quietly, with no warning" → "The drift comes with no warning"; "the work naturally organizes itself" → "the work falls into loops"; removed "simply cannot offer" and "blindly obey".
- **Bold-led bullet pattern:** the four-item "**Safe pauses.** … **Mid-flight steering.** …" list became ordinal prose paragraphs ("The first is safe pauses. … The fourth matters most: …"), which also breaks the flat four-item parallelism.
- **Throat-clearing / filler:** "worth saying plainly" cut from the coordination-delay definition; "Strip it all back and the message is simple." cut from the close; the invented bold label `**coordination delay**` de-emphasized to plain "coordination delay".
- **Redundant restatement beats:** dropped the trailing bold echoes "**Ambiguity never silently becomes a guess.**" (rewritten) and "**Done means merged — verified, never assumed.**" (removed; the paragraph already states it).

Verification: `npm run verify` exits 0, docs link check passes. The `.md` and `.html` remain in content parity (HTML lede still expands the subtitle as before).
