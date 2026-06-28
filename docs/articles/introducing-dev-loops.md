---
title: "Introducing dev-loops"
subtitle: "A coordination runtime for AI-assisted development, dogfooded so hard it builds itself."
tags:
  - AI
  - Software Engineering
  - Developer Tools
  - Automation
  - Productivity
---

# Introducing dev-loops

AI writes the code in seconds. The hours now go somewhere else: into the handoffs around the code. A change waits for someone to notice it is ready, waits for a reviewer to rebuild enough context to have an opinion, waits in a queue for the one person who can say whether the next step is safe. That waiting between actions is coordination delay, and it is where the lead time of an AI-assisted workflow actually goes.

dev-loops is a coordination runtime that closes that gap. It walks a change from a plan or an issue through review and into a merged pull request, treating every handoff as an explicit decision a human can see, with a human merging by default. This article covers what it does, the evidence that it works, and how to put it in your own project.

It is also written through its own flow. This piece began as a plan file, was validated and refined in place, paused at a local human-review checkpoint, and was promoted to a single draft pull request that then ran the same gates as everything else. The loop that ships the loop also ships its articles.

## Act 1 — Why it exists, and the proof

The deep mechanics live in two companion articles linked at the end. Here is the short version. Most lost hours in an AI-assisted workflow happen in the seams between steps, where the system has to answer "who acts next?" or "is this ready?" and an unattended agent answers with a hopeful assumption it never checks. It marks the build passed, marks the review done, and calls the work finished while those assumptions go untested. dev-loops refuses the assumption everywhere. Every transition becomes a decision the system makes deliberately and records where you can read it; when the situation is ambiguous, it stops and a human resolves it before the work moves on.

The proof is the repository itself. dev-loops develops dev-loops: the loop is the tool that ships its own changes, so its commit history is a continuous integration test of the claim. Over roughly fourteen days (2026-06-14 to 2026-06-28) the repository merged about 100 pull requests and closed about 96 issues, around 7 merged pull requests a day, with about 89% of merged pull requests closing a linked issue. Every one of those pull requests went through the same path: a draft gate that confirms checks are present, a Copilot review round, and a pre-approval gate that confirms CI is green, with a human performing the merge by default.

A handful of concrete runs show what that path catches.

**A waterfall that mints almost no tracker noise.** The local-first epic (#947) decomposed into six refined phase sub-issues, each promoted to its own gated pull request: #956, #957, #959, #960, #961, #962, plus the docs-grill formalization (#948 to #958). One phase, P4 (#960), is PR-first by design: it commits a plan document and opens a single draft pull request, minting no issue at all. The committed plan doc and the pull request are one artifact, so there is no second authority to keep in sync.

**A documentation check that runs inside the loop.** The docs-grill standard step (#948 to #958) is an autonomous in-loop check of a change against the repository's own contracts: claims versus contracts, code versus documentation drift, stale references. Its first live run, during P6 (#962), caught real drift before merge: a contract still claimed the shipped default was `github-first` via a settings file that no longer ships, and still described the repository's own mode as tracker-first when its config sets `local-first`. Both were fixed in place during refinement, before the pull request reached a human.

**Gates catching real defects.** The mobile-fit Playwright hardening (#937 to #938) failed on the pre-fix layout and passed only after the fix, with a guard-the-guard test confirming the check itself fails on a deliberately broken element. The round-cap Copilot deadlock (#848 to #854) is the loop catching its own state machine: when a post-cap fix left the Copilot gate waiting on a review that could never satisfy it, the loop detected the unsatisfiable wait at the cap and routed to a clean fallback.

**Dogfooding surfacing its own tooling gaps.** Running the loop turned up #963: the operator action scripts emit machine JSON only, so a human or an agent driving the gate cadence had to re-parse a raw blob just to read the result. The fix adds a concise summary output mode. The same A/B-contrast deslop step (#944 to #945/#946) that polices these articles' prose runs over the loop's own writing, removing binary-contrast phrasing from the articles and the decks.

## Act 2 — Adopt it in your project

dev-loops runs under two harnesses, and the configuration forks at a few decision points. The keys below are the real shipped names.

**Pick your harness.** Under Claude Code the dev-loop runs as a single agent that performs the steps directly: it reads and writes files, runs git and the pull-request lifecycle, and posts gate verdicts under the operating session's identity (see `skills/docs/main-agent-contract.md`). Under Pi the main agent is read-only and every mutation flows through an async `dev-loop` subagent. The contract is the same; the harness decides who holds the pen.

**Pick where work originates.** Two config keys set the intake shape:

- `strategy.default` is `local-first` (the shipped extension default) or `github-first` (the built-in fallback in `config.mjs`). Local-first starts work from a plan file you author in the repository; github-first starts from a tracker issue.
- `inputSource.default` is `tracker` (the issue body is the spec) or `phase-docs` (a phase document is the spec).

These ship in `packages/core/src/config/extension-defaults.yaml`; the built-in `github-first` fallback lives in `packages/core/src/config/config.mjs`, and your repo's `.devloops` overrides both.

**The local-first flow.** When work starts from a plan file, four helper scripts run in order (see `skills/docs/local-planning-flow.md`):

1. `scripts/refine/validate-plan-file.mjs` checks the plan's base sections (Status, Objective, In scope, Explicit non-goals).
2. `scripts/loop/resolve-dev-loop-startup.mjs --plan-file <path>` reads the plan and resolves an intake state.
3. `scripts/refine/refine-plan-file.mjs` writes the acceptance criteria, definition of done, coverage matrix, and recorded docs-grill findings back into the plan in place, then stops at a `local_human_review` checkpoint so you approve before anything is promoted.
4. `scripts/refine/promote-plan.mjs` commits the plan and opens exactly one draft pull request, recording a bidirectional plan-to-PR link and minting no issue.

For a tracker-first epic, refinement is a waterfall instead: an epic issue decomposes into a sub-issue phase tree, and the refiner produces acceptance criteria and a definition of done for each phase. This article and the local-first epic above are both worked examples of that flow.

**Tune the gates.** A few more keys control how strict the loop is:

- `refinement.maxCopilotRounds` (default 5) sets how many Copilot review rounds run before the loop converges; set it to `0` to disable Copilot review entirely.
- `autonomy.humanMergeOnly: true` makes the merge an enforced repo invariant: the loop runs the full pre-merge evidence check and reports merge-ready, and a named human performs the merge. Local-first ships with this on, so it never auto-merges.
- `workflow.requireDraftFirst: true` requires a pull request to open as a draft and pass the draft gate before it can be marked ready.

That is the whole adoption path: choose a harness, set `strategy.default` and `inputSource.default` for how work arrives, run the flow, and dial the gate keys to the strictness your team wants. Start with the shipped local-first defaults and loosen from there.

## Where to go deeper

Two companion articles take the ideas here apart in detail. [Eliminating Coordination Delay in AI-Assisted Dev Workflows](./eliminating-coordination-delay.md) explains why every handoff becomes an explicit decision and why the loop runs on a state graph. [Make the Waiting Visible](./make-the-waiting-visible.md) is about measuring the waiting between actions, which is where the lead time goes once the code itself is fast to write.
