# A/B contrast removal — a standard deslop step

A repeatable editorial step for written deliverables (articles, decks, docs, READMEs). It targets one antipattern: the **binary-contrast / negation-by-contrast** construction, the strongest single AI tell in generated prose. Since **ADR 0041** this step is a **required, fail-closed gate angle**: a prose diff (`docs/articles/**`, `docs/presentations/**`, `README*`, narrative `docs/*.md`) arms the `deslop` gate angle, which runs this step per document (one reviewer per document; the existing fan-out mechanism already does that) and blocks on any surviving binary-contrast construction. Normative contracts under `skills/docs/**` are exempt — they are governed by the contract style guide and contradiction lens, and deslop's contrast-cutting must not fight required RFC-2119 modality. The existing light-mode and spike-mode relaxed gate carve-outs apply to this angle as they do to other gates. This is the first documented sub-step of the broader deslop step tracked in [#936](https://github.com/mfittko/dev-loops/issues/936).

## The antipattern (both orderings)

Flag the construction in either direction. "A/B" and "B/A" are the same tell:

- **A-then-B:** "Not X. Y.", "X, not Y.", "rather than A, B", "instead of A, B", "It isn't A, it's B", "X does A; it can't do B".
- **B-then-A:** "Y, not X.", "It's B, not A.", "B, not because X but because Y."
- **Negation-by-contrast:** stating what something *isn't* to set up what it *is* ("does not pick the likeliest path; it stops and asks").
- **Dramatic antithesis pairs and fragments:** "Where X, Y.", "X is cheap; Y is where the cost moved.", "not just A but B", "less A, more B", one-word contrast fragments ("until it doesn't").

Deck and section headlines attract this construction especially ("Prompts Drift; State Can't", "Aren't a Wish, They're …").

## The flow

1. **Parallel analysis.** One reviewer per document, fanned out. Each reports every instance with a line ref, the exact quote, the pattern, and a proposed rewrite. Be exhaustive; a missed instance is the failure mode.
2. **Final check.** An independent verification pass per document that catches misses (the construction is easy to miss at scale) and guards against over-correction.
3. **Human-likeness pass.** Removing every contrast can flatten prose into a monotone run of declaratives. A short pass restores natural rhythm and connective tissue, without reintroducing any contrast.

## The rewrite rule

Cut the contrast *scaffolding and dramatic cadence*. Keep load-bearing factual distinctions, stated plainly and confidently:

- State the value directly. No hype, no selling, no underselling, no hedging into "might help".
- Keep genuine technical distinctions as flat facts. "The merge state is read from CI" carries the same point as "verified, not assumed" without the construction.
- Vary sentence length and use natural connectives (because, so, and, which, when).

## Keep vs. cut

| Cut (pure scaffolding) | Keep (load-bearing, restated plainly) |
| --- | --- |
| "It isn't bureaucracy. It is what makes …" | "Treating every handoff as a decision makes …" |
| "verified, not assumed" | "CI-green comes from the real check result" |
| "pickup becomes continuation instead of investigation" | "pickup becomes a continuation of work already in motion" |
| "Stop optimizing how fast you write code. Start measuring how long it waits." | "The lever you control is how long it waits afterward, so measure that." |

Not every "not" is the antipattern. A real conditional ("more hands help only when the state crosses intact") or a genuine either/or of behavior stays; only the dramatic-contrast crutch goes.

## First runs

The two Medium articles were the first documents run through this step (analysis found ~120 instances across the articles and the two decks): `docs/articles/eliminating-coordination-delay.md` and `docs/articles/make-the-waiting-visible.md`, with their HTML renders and review notes. See the `A/B contrast pass` section in each article's `-notes.md`.
