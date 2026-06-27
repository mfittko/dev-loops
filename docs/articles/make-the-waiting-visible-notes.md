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
