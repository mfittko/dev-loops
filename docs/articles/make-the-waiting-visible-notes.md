# "Make the Waiting Visible" — editorial / storytelling review notes

Article: [`make-the-waiting-visible.md`](make-the-waiting-visible.md) ·
HTML preview: [`make-the-waiting-visible.html`](make-the-waiting-visible.html).

## Review brief

Public, non-insider audience (engineers, EMs, anyone shipping software with AI
in the loop). Intended takeaway: *generation is fast now; the waiting between
actions is the slow, unmeasured part — make the state observable, measure the
waits, then change the process.* Pay extra attention to: a real hook (not a
symptom statement), no internal enum/identifier walls, every claim grounded,
and a close that lands as a line rather than a feature list.

## Lens applied

One pass through the [slides content & storytelling review loop](../slides-story-review-loop.md)
lens, adapted from per-slide to per-section prose: **arc** (hook → tension →
resolution), **one message per section** (heading states a claim, not a topic),
**sequencing** (no forward references; terms introduced before use),
**audience calibration** (no raw identifiers / version pegging), **cut / merge /
reorder**, and a **memorable close**.

## Findings & corrective actions (applied)

| # | Finding | Section | Severity | Corrective action (applied) |
|---|---------|---------|----------|------------------------------|
| 1 | Figure 2's handoff diagram used a single compound node ("Work resumes... then waits again") that smuggled two ideas into one box and read awkwardly as a static image. | Every Handoff… | medium | Split into four crisp nodes (ask → answer → confirm → resumes) with the loop-back as a dashed "next ambiguity" edge; moved the "then waits again" idea into the caption where it reads as narration. |
| 2 | In the interrupt chain, the body says "the answer itself is the small box in the middle," but neither the Markdown nor HTML diagram marked *which* node is the answer — the reader had to infer it. | One Interrupt… | medium | In the HTML render, accented the `Act` node (it is the answer) so the "small box in the middle" claim is visible; caption now names Act explicitly. (Markdown kept plain — mermaid styling left out to avoid theme noise; caption carries it.) |
| 3 | Risk of the "four fields" reading as an unsupported wish — the classic floating-promise failure the deck's review flagged. | Four Fields… → grounding | high | Confirmed the grounding section (board / gate trail / resolver) directly answers the skeptic ("just better tickets?") and Figure 4 visually ties each field to a mechanism. No rewrite needed; verified the forward reference is *paid off* within two sections, not dangling. |
| 4 | Close risked restating the body as a checklist (mechanism list) rather than landing a line. | Stop Optimizing… | medium | Kept the three-mechanism recap but ended on the bolded one-liner ("Stop optimizing how fast you write code. Start measuring how long it waits.") as the final beat, mirroring the deck's punchline close. |
| 5 | Audience calibration: scanned for version pegging and raw enum/state-machine identifiers. | all | low | None present — mechanisms are described in plain language (board columns, review gate verdicts, deterministic resolver, provider-agnostic CI wait, post-merge reclaim/archive); no version numbers, no raw config keys. No change. |

## Sequencing / arc check

Hook (speed → it sits) → interrupt cost (5 transitions) → handoff cost
(discovery restart) → blind spot (git history hides it) → the fix (4 fields) →
measure (loop) → grounding (board/gate/resolver) → close. Each section has one
claim-style heading; no term is used before it's introduced; the grounding
section is the only forward reference and it resolves the "four fields" promise.

## Outcome

`story_review_satisfied` — arc is intact, each section carries one message, the
promise is grounded, jargon is translated, and the close lands as a line.
Remaining nits (mermaid node styling parity between MD and HTML) are minor and
covered by captions.

## Deslop pass

A second pass stripped AI-writing tells from the prose only. Structure,
headings, the four mermaid diagrams and their HTML renders, the figure
captions, the front-matter, the Medium rendering note, and the dark visual
identity were left untouched. The `.md` and `.html` stay in content parity.

Em-dash count (prose): MD went from 29 total to 0 in prose (4 remain, all inside
*Figure N* captions, which are preserved). HTML went from 31 `&mdash;` to 8 (all
8 in figure captions and the Figure 4 SVG text node — none in prose).

Tells removed (representative before → after):

- **Throat-clearing opener.** "Watch an AI agent work and the first thing you
  notice is the speed." → cut; the section now opens on the concrete claim
  ("A change that used to take an afternoon now lands in seconds.").
- **Dramatic one-line fragment.** "Then the work *sits*." as its own paragraph →
  folded into the paragraph that follows, so the rhythm isn't a stacked
  fragment.
- **Em-dash appositives throughout.** "That gap — the waiting between actions —
  is where your real lead time goes" → "The waiting between actions is where
  your lead time goes now." Same for "recover — climb back into the work",
  "don't add up — they multiply", "ask — and now you've paid", "back-and-forth
  — the conversation", "chase generation speed — a faster model".
- **Rhetorical self-question answered immediately.** "It doesn't." after "feels
  like it costs the minute it takes to answer" → merged into one sentence with
  "but the real cost is the chain it sets off."
- **Magic adverb.** "the state can *quietly* drop on the floor" → "the state can
  drop on the floor."
- **Patronizing meta-framing.** "Start with the unit of waiting everyone
  underestimates: the interruption." → "Everyone underestimates the
  interruption." And "Zoom out from a single interrupt to a single handoff, and
  the pattern repeats at a larger scale." → "The same pattern repeats one level
  up, at the handoff."
- **Inanimate subject + emphasis crutch.** "the waiting is invisible to every
  tool you already trust" → "none of the tools you already trust can see the
  waiting" (named actor, active voice).
- **Filler intensifier.** "lets you *actually* shorten it" / "whether the wait
  *actually* dropped" → "actually" cut both times.
- **Negation-by-contrast heading.** "Those Four Fields Aren't a Wish — They're
  Where the Work Already Lives" → "Those Four Fields Already Live in the Work."
- **Passive constructions.** "Once state is captured at each transition" → "Once
  you capture state at each transition"; "The wait at CI is handled by waiting
  on" → "Handle the wait at CI by waiting on"; "finished workspaces are
  reclaimed" → "finished workspaces get reclaimed."
- **Formulaic close.** "So stop optimizing how fast you write code. Start
  measuring how long it waits." (binary imperative pair) → "The next agent will
  write your code in seconds either way. What you control is how long it waits
  afterward, so measure that."

Bold-led bullets and bold-led grounding paragraphs were kept: the bold spans are
the names of the four fields and the three mechanisms (load-bearing labels, not
decoration). Only the em-dashes trailing them were converted to commas.

Verify: `npm run verify` exits 0.
