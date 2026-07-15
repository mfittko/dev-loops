---
title: "Introducing dev-loops"
subtitle: "A coordination runtime for AI-assisted development — and a guide to running it yourself."
heroLede: "The slow part of AI-assisted development is no longer writing code — it is the coordination around it. dev-loops runs those in-between steps as recorded decisions, with a person at the merge by default."
tags:
  - AI
  - Software Engineering
  - Developer Tools
  - Automation
  - Productivity
---

# Introducing dev-loops

The slow part of AI-assisted development is no longer writing code. It is everything that has to happen around the code: someone notices a change is ready, rebuilds enough context to review it, checks that the tests ran, decides the next step is safe. Each of those is a small wait, and once the typing is fast, the waits are where the lead time lives.

dev-loops is a runtime for those in-between steps. It keeps the state of every change explicit, computes the next action from that state, and runs the routine transitions itself — drafting, reviewing, gating on green CI — while recording each decision where you can read it. A person stays at the merge by default. This article explains the idea, shows what it does on a real repository, and walks through running it on your own project. A deeper piece is linked at the end.

## The idea

An agent left to its own devices tends to assume its way past the hard moments: it declares the review done, the tests good enough, the work finished, and nobody checks the declaration until something breaks. dev-loops replaces each of those assumptions with a decision the system takes deliberately. Is this change ready for review? Did the review actually run, with evidence? Is CI green on the current head? Every transition is computed, applied, and recorded — and when the answer is ambiguous, the loop fails closed and waits for a person rather than guessing.

Three ideas carry most of the value:

- **Every change walks the same path.** A draft gate checks the basics, automated review rounds look for real problems, and a pre-approval gate re-checks the final state — with green CI required at both gates unless a repository explicitly opts out. Nothing skips the path, including every change that built dev-loops itself.
- **A person merges by default.** Out of the box the loop stops at the merge and hands over; it merges on its own only when a repository grants that explicitly. There is also a stricter setting that makes the merge human-only no matter what any single run claims — it cannot be overridden from inside the loop.
- **Work starts from a durable spec.** A change begins as a short plan file in the repository or as a tracked issue, and the pull request carries that spec through review to merge. There is always a written artifact to check the result against.

None of this is tied to one model or one editor, and the section [Model-agnostic by construction](#model-agnostic-by-construction) explains why that follows from the design. dev-loops is a runtime for the decisions around a change, and it runs inside the AI coding tools teams already use.

## What it does to the work

Coordination is the cost that compounds. Every change carries a handful of transitions — is it ready, who reviews it, did the review pass, is CI green, can it merge — and every transition a person runs by hand is an interrupt with a context-switch attached. Multiply transitions per change by the number of changes and the hand-run coordination grows much faster than the throughput it supports. That compounding, not the code, is what caps how much an AI-assisted team ships.

The loop breaks the compounding by turning each transition into a machine decision with a log. What remains for the human is roughly one bounded decision per change: the merge, plus anything the loop flags as unclear.

dev-loops is developed with dev-loops, so the honest evidence is its own history. The numbers below come straight from the repository's git log, not from a benchmark:

<!-- metrics:start -->
- **534** pull requests merged in the project's first nine weeks
- **~10/day** over the most recent two weeks (138 in fourteen days)
- **24** tagged releases in the same stretch, up to a 1.0 release candidate
- **1** human decision per change — the default posture stops at the merge
<!-- metrics:end -->

The review load behind that pace is real work, and it is where the loop earns its keep. At the draft gate, review fans out to focused reviewers that each read the change through a single lens — scope, coverage, correctness, and input validation among them. Before approval, a second fan-out applies design and simplicity lenses (DRY, KISS, YAGNI, single-responsibility) plus a check of the change against its own written acceptance criteria. Findings land as comments on the pull request, and a finding rated must-fix blocks a clean verdict until it is addressed. The gate sits exactly where unattended automation is usually weakest — the moment a change is about to land — so the cadence stays fast while the merges stay ones a person can stand behind.

## Model-agnostic by construction

The same loop runs three ways over one shared core: as a Claude Code plugin, as a Pi extension, and as a standalone CLI. Routing, gates, and phases are defined once; the harnesses are thin integrations over that shared workflow.

Model choice is configuration in the same spirit. Roles map to model tiers, and tiers map per harness to concrete models: routine subagents (implementation, docs, small fixes, build chores) default to the low tier, while planning and review — the steps that guard quality — run on the high tier, and the conductor inherits whatever the session runs. Swapping the model behind any role is a config edit, not a code change.

That split is the practical argument for model flexibility. The structure constrains how far any single step can stray: each step is bounded, each gate fails closed, and the review fan-out checks the work regardless of which model produced it. So the quality bar sits where the gates put it, and a cheaper or self-hosted model can carry the routine steps while the strongest model you have is reserved for the judgment-heavy ones.

## Set it up

dev-loops drives an ordinary GitHub pull-request workflow from inside Claude Code or Pi. You need Node 24 or newer and the GitHub CLI (`gh`) authenticated for your repository.

**Claude Code.** Install the plugin from the bundled marketplace catalog:

```text
/plugin marketplace add mfittko/dev-loops
/plugin install dev-loops@dev-loops
```

**Pi.** Install the extension from npm, pinned to a version so the surfaces cannot drift:

```bash
pi install npm:dev-loops@<version>
```

**Run a loop.** The named commands are direct entrypoints; you never pick internal modes. On Claude Code:

```text
/loop-start 112          # start a dev loop on a tracked issue
/loop-auto 112           # run autonomously to the human-approval checkpoint
/loop-continue 112       # continue work on an issue or PR
/loop-continue           # bare: resume the single in-progress item (fails closed on 0 or several)
/loop-start-spike "why does checkout stall?"   # time-boxed exploration
/loop-info 112           # read-only state summary for an issue or PR
/loop-status             # readiness check: gh auth, git repo, subagents
```

On Pi the same set is reachable as subcommands of one command: `/dev-loops start 112`, `/dev-loops auto 112`, `/dev-loops continue`, and so on. Plain language works too — `start dev loop on issue 112` or `continue dev loop on PR 88` routes through the same deterministic contract, so the named commands are thin shortcuts, not a separate mechanism.

**Tune the posture (optional).** A `.devloops` file at the repository root controls how work arrives and how strict the loop is:

```yaml
# .devloops
version: 1
strategy:
  default: local-first    # start from a local plan file; github-first starts from issues
inputSource:
  default: tracker        # read the spec from the issue body, or phase-docs
refinement:
  maxCopilotRounds: 5     # automated review rounds before converging; 0 turns Copilot off
autonomy:
  humanMergeOnly: true    # merge stays a human-only action, regardless of any per-run flag
```

Three choices shape the experience. Work can start **local-first** — you write a short plan in the repository and the loop opens a pull request straight from it — or **github-first**, where a tracked issue is the starting point. The automated review rounds can lean on Copilot or run without it. And the loop merges on its own only if you explicitly allow it; by default it stops and hands the merge to you. Start with the shipped defaults and dial each setting toward the autonomy your team is comfortable with. As of 1.0 this configuration surface follows semantic versioning, so a `.devloops` file you write today keeps working across minor upgrades.

## Where to go deeper

The [dev-loops deep dive](./dev-loops-deep-dive.md) takes these ideas apart in detail, in two parts: why the next step is always computable from visible state, so the next actor pulls work instead of waiting for a handoff — and how to measure the waiting between actions, which is where the lead time goes once the code itself is fast to write.
