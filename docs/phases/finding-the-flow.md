---
prNumber: 2234
---

# Finding the flow presentation

## Status

Implemented and approved for draft PR creation. This plan promotes the local planning artifact used during authoring; it records the user-approved final scope. Merge and live deployment are not authorized by this handoff.

## Objective

Create a company-wide conference presentation about graphs and workflows that make AI-agent processes more predictable. Explain enforceable boundaries, recovery and human authority without promising deterministic model output.

## In scope

- A self-contained 43-slide HTML presentation, with 50 minutes of content including a two-minute exercise and ten minutes for questions.
- Worked customer-reply graphs, conceptual grilling, dev-loops routing and review/repair, and the UI sub-loop used to prepare this presentation.
- Human decisions, acceptance-criteria authority, cost per accepted result, context/caching tradeoffs, reviewer/model selection, tool results and budget exhaustion.
- Speaker notes and primary-source research, with observed behavior separated from proposed controls and design inferences.
- Plain-language editorial review preserving the title, message and existing presentation UI.
- Shared browser checks and existing GitHub Pages build/navigation integration.

## Explicit non-goals

No changes to agent runtime behavior, new dependencies, live deployment or merge. No invented performance or savings claims. Jev research and any related issues or implementation are separate work.

## Acceptance criteria

- [x] The deck is titled Finding the flow, with the subtitle Loops, graphs, and more reliable AI agents, and is readable by a broad audience.
- [x] The presentation distinguishes deterministic permitted transitions from fallible model decisions and evidence; protected transitions fail closed when required evidence is missing.
- [x] Material acceptance-criteria changes require human authority and invalidate all prior-spec clearance, including when implementation code is unchanged.
- [x] Graphs show permitted paths, repair/retry boundaries, human decisions and freshness; conceptual and UI examples distinguish observed execution from proposed rules.
- [x] All 43 slides have speaker notes, linked supporting research and a running order totaling 60 minutes.
- [x] Browser coverage checks slide fit, navigation, runtime behavior, accessibility, counts and timing.
- [x] Pages copies the deck unchanged to finding-the-flow.html and links it through existing site navigation.

## Definition of done

- [x] Presentation, notes, research, browser registration and Pages integration are committed on the isolated feature branch.
- [x] Relevant browser, Pages, documentation and contract checks pass; validation scope and limitations are reported.
- [x] A self-assigned draft PR links this plan and summarizes the complete presentation and Pages scope.
- [ ] Subsequent lifecycle gates and human approval precede any merge; draft creation does not imply approval or deployment.

## Risks and open questions

The talk teaches workflow design rather than proving measured reliability gains. Source claims are pinned or dated in the research companion. A successful check can miss semantic or visual errors; human review remains necessary. No unresolved choice blocks draft PR creation.

## Size estimate

One cohesive presentation plus its supporting notes, research, browser coverage and Pages registration. Most added lines are presentation content; no new runtime dependency is introduced. Keep these artifacts together so reviewers can inspect the talk, its evidence and its published build as one unit.
