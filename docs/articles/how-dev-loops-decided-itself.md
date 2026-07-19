---
title: "How dev-loops Decided Itself Into Shape"
subtitle: "A working system that kept a record of its own architecture decisions, reversed the ones that were wrong, and got measurably better while doing it."
heroLede: "Over 68 days the project made forty architecture-shaping decisions, wrote each one down, and reversed the two that turned out wrong. This is the history read straight from that record."
tags:
  - AI
  - Software Engineering
  - Developer Tools
  - Process
  - Architecture Decisions
outro: closer
---

# How dev-loops Decided Itself Into Shape

> New here? Start with [Introducing dev-loops](./introducing-dev-loops.md) for the overview and [the deep dive](./dev-loops-deep-dive.md) for the mechanics. This article is the history: how the system arrived at its current shape.

Most projects explain what they are. This one can explain *why it is the way it is*, because it kept the receipts. Forty architecture decisions live in the repository as dated records under `docs/decisions/`, each linking the pull request or issue that made it real. Reading them in order is like watching the system argue itself into its current form — and reverse course twice when the argument turned out wrong.

This article walks that record. Every figure below was re-derived from the repository at the time of writing.

<!-- metrics:start -->
- **68** days from first commit to the v1.0.0-rc.3 release candidate
- **1,328** commits across 687 merged pull requests
- **26** tagged releases, with 7 reverts — about 1% of merged PRs, mostly in release mechanics and doc rewrites
- **40** recorded architecture decisions, 2 of them later superseded
- **2,972** automated checks, up from a suite of 146 test files to 190
<!-- metrics:end -->

## The method is the point

A decision earns a record when it shapes policy or architecture — a review economics choice, a seam other work has to build against, or a reversal of something already established. Routine features and fixes stay out. That bar keeps the log to the load-bearing forty, which is few enough to read in a sitting and honest enough to include the mistakes.

The record itself is plain: context, decision, consequences, and a dated link to the accepting event. When a later decision overturns an earlier one, the old record stays and its status flips to superseded, with a link forward. Nothing is quietly deleted, so the history stays legible even where it doubled back.

## Era one: the next step is always known

The earliest records fix the idea the whole system rests on. Work flows through a deterministic state graph where the next action for any change is computed, not remembered (records 0001 and 0002). A single startup resolver reads authoritative state and hands back a bounded task with the exact files to read and the exact stop conditions (record 0011, and the handoff envelope in record 0016). Loss of a temporary artifact degrades fidelity and the run still recovers, because the graph, not the chat transcript, is the source of truth.

This is what lets an agent pick up work mid-flight without guessing. The state is on the board; whoever is free reads the next card and pulls it.

## Era two: the gate

Seventeen days in, on 2026-05-29, the review model arrived that still defines the project (record 0006): two gates, a draft gate before review and a pre-approval gate before merge, with merge authority reserved for a human (record 0007). Gate verdicts became durable, fail-closed evidence rather than an agent's say-so — a comment the coordinator refuses to post unless the checks actually succeeded (record 0008).

The consequence compounds through everything after it. Once a green result has to come from the real check, the agent can no longer assume the build passed. The single most common failure of an autonomous coder — declaring success over an unverified assumption — is closed off at the seam.

## Era three: portability, then a reversal

The runtime began coupled to one agent harness. The adapter-seam decision decoupled it (record 0020), routing every harness dependency through frozen, validated boundaries with implementations for each host and a generator that fails the build on drift. The system could now run under more than one harness without a parallel copy of its assets.

Then the first big reversal. The project had started tracker-first: every change minted a GitHub issue, went through refinement ceremony, and produced a phase document (record 0003, 2026-05-15). Operating experience showed most work is specified and reviewed better locally, before it touches the tracker. So the default flipped to local-first, with a lightweight path that treats a pull request description itself as the spec (record 0018, 2026-06-12, supersedes 0003). The old record stays in the log, marked superseded, because the wrong turn is part of the history worth keeping.

## Era four: the loop turns on itself

The later records are the system improving its own machinery. Review fans out into independent angles and fans back in (record 0021). A round cap keeps the Copilot review loop from spinning (record 0012). Every operator-facing tool gained a uniform, machine-readable output contract, enforced by a test that fails the build if a new command ships without it (record 0025). Rule identifiers became single-owner and permanent (record 0027).

The sharpest of these came from a mistake the system caught in itself. Gate reviews had drifted toward grouping several review angles into one agent to save tokens, which quietly recreates a single reviewer approving their own bundle. The fix made one scoped reviewer per fresh angle a machine-enforced requirement at both write and read time (record 0039) — and the new floor then caught its own author miscounting reviewer provenance within hours of shipping.

The second reversal lives here too. An enforced retrospective gate, meant to make the system reflect before merging, kept deadlocking ordinary product work on self-analysis noise (record 0009). The decision that followed made the retrospective advisory: its findings travel in the handoff envelope and a comment, and never block a merge (record 0024, 2026-07-02, supersedes 0009). A valuable practice had been mounted at the wrong boundary, and the log records both the mounting and the correction.

## Did it actually get better?

The record shows learning at the policy level. The stronger question is whether the code and the delivery got better in measurable terms, and the repository answers it directly.

The clearest external signal is review pressure. Counting Copilot's review comments per thousand added lines, week over week, the density fell as the internal gates came online and held — roughly halving from the early weeks to the recent ones. The reviewer that sits outside the system found less to say as the system's own checks caught more first.

Escaped defects stayed rare. Across nearly seven hundred merged pull requests, the count of changes that had to be reverted sits at seven, and those cluster in release mechanics and documentation rewrites rather than gated code paths. The test suite grew alongside the surface it guards, from 146 files to 190, and the contract tests — the ones that fail the build when a rule or an output shape drifts — grew fastest, because each hard-won convention got a guard so it could not quietly erode.

None of this is a claim that the process is finished. Two of forty decisions were wrong enough to reverse, and the reversals are in the log on purpose. The point is narrower and, for an AI-assisted project, unusual: the system changed its own rules deliberately, wrote down why each time, and the numbers moved the right way while it did.

## What the log is for

A decision record is cheap to write and expensive to skip. Skip it, and six weeks later nobody remembers whether the absolute links in the installed docs were a considered choice or an accident, whether the retrospective was meant to block merges, whether one-reviewer-per-angle was a rule or a habit. The log answers all three, with dates and links, because someone wrote three paragraphs at the moment the decision was made.

That is the whole practice. The next step is always known, the gate never trusts an assumption, and when a decision turns out wrong, the record of it stays — so the correction has something to point back to.
