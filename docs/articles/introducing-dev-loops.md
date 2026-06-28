---
title: "Introducing dev-loops"
subtitle: "A coordination runtime for AI-assisted development — and a guide to running it yourself."
tags:
  - AI
  - Software Engineering
  - Developer Tools
  - Automation
  - Productivity
---

# Introducing dev-loops

AI writes the code in seconds. The expensive part moved. It now sits in the coordination around the code: the wait for someone to notice a change is ready, to rebuild enough context to review it, to decide the next step is safe. That waiting between actions is where the lead time of an AI-assisted workflow goes once the typing is fast.

dev-loops is a coordination runtime for that problem. It carries a change from an idea to a merged pull request and treats every handoff along the way as an explicit decision that gets written down, with a person merging by default. This article introduces the idea and shows how to run it on your own project. Two deeper pieces are linked at the end.

## The idea

Left alone, an agent tends to assume its way past the hard moments. It marks the build passed, calls the review done, decides the work is finished — and those assumptions go unchecked until something breaks downstream. dev-loops takes the assumption out. Every transition — is this ready, who acts next, is it safe to merge — becomes a decision the system makes deliberately and records where you can read it. When the answer is unclear, the loop stops and a person decides before the work moves on.

Three ideas carry most of the value:

- **Every change runs the same path.** A draft check confirms the basics are in place, a review round looks for real problems, and a final gate confirms the tests are green. Nothing skips the path, including the changes that built dev-loops itself.
- **A person merges by default.** The loop does the preparation and reports that a change is ready; a human makes the final call. The autonomy is bounded on purpose, and you choose how much of it to grant.
- **Work starts from a durable artifact.** A change begins from a short plan you write locally or from a tracked issue. That artifact is the spec, and the pull request carries it through review to merge, so there is always something to check the result against.

None of this depends on a particular model or a particular editor. It is a runtime for the decisions around a change, and it runs inside the AI coding tools teams already use.

## What it does to the work

The point of the loop is what it does to the day-to-day of shipping. The clearest evidence is the project itself: dev-loops is built with dev-loops, so its own history shows the process it produces.

Coordination is the cost that grows. Every change carries a handful of transitions — is it ready, who reviews it, did review pass, is CI green, is it safe to merge — and each one a person handles by hand is an interrupt with its own switching cost. As the change count climbs, those manual transitions multiply against it: their number is the transitions per change times the volume, so hand-run coordination acts like a power over the throughput, and a person's effective load grows far faster than the number of changes. That compounding is what caps how much an AI-assisted team can actually ship, even once the code itself is cheap to produce.

dev-loops breaks the compounding by making each transition a decision the system takes and records. Every change follows the same path — draft, review, green-CI gate, human merge — so there is no bespoke ceremony to design and no question about what happens next. A person is pulled in only where one is genuinely needed: the merge, and anything the loop flags as ambiguous. What is left for the human is roughly one bounded decision per change; the transitions in between are the loop's to run and to log.

That is what the project's own history shows. In a recent two-week stretch the repository merged about 100 pull requests — roughly seven a day — each one drafted, reviewed, gated on green tests, and merged by a person, with about seven in eight tied to a tracked item so the trail from intent to merge stayed legible. The cadence held as the change count rose because the extra work landed as machine transitions, with the human's part staying that one bounded decision at the merge.

And it stays honest at that speed. The review step keeps catching what slips past a tired reviewer in a hurry: a layout that broke on small screens, documentation that had drifted from the code, a review cycle that had quietly deadlocked. The loop earns its keep at the moment a change is about to land, which is where unattended automation is usually weakest — so the cadence is fast and the merges are still ones a person stands behind.

## Set it up

dev-loops runs inside Claude Code or Pi and drives an ordinary GitHub pull-request workflow. You need Node 24 or newer and the GitHub CLI (`gh`) authenticated for your repository.

**Claude Code.** Install the plugin from inside Claude Code:

```text
/plugin marketplace add mfittko/dev-loops
/plugin install dev-loops@dev-loops
```

**Pi.** Install the extension:

```bash
pi install npm:dev-loops
```

**Start a loop.** There is one plain-language entrypoint; you never pick internal modes:

```text
start dev loop on issue 112      # begin work from a tracked issue
auto dev loop on issue 112       # run autonomously up to the human-merge checkpoint
continue dev loop on PR 88       # pick up an open pull request
```

**Tune the posture (optional).** A `.devloops` file at the repo root controls how work arrives and how strict the loop is. The shipped defaults are a low-noise starting point; loosen from there.

```yaml
# .devloops
strategy:
  default: local-first    # start from a local plan file; use github-first to start from issues
inputSource:
  default: tracker        # for local-first: read the spec from the issue body, or phase-docs
refinement:
  maxCopilotRounds: 5     # automated review rounds before converging; set 0 to turn Copilot off
autonomy:
  humanMergeOnly: true    # the loop prepares and reports ready; a person merges
```

Three choices shape the experience. Work can start **local-first** — you write a short plan in the repository and the loop opens a pull request straight from it, with no issue to file — or **github-first**, where a tracked issue is the starting point. The review round can lean on Copilot or run without it. And the loop merges on its own only if you explicitly allow it; out of the box, it stops and hands the merge to you. Begin with the defaults and dial each setting toward the autonomy your team is comfortable with.

## Where to go deeper

Two companion articles take these ideas apart in detail. [Eliminating Coordination Delay in AI-Assisted Dev Workflows](./eliminating-coordination-delay.md) explains why every handoff becomes an explicit decision and why the loop runs on a state graph. [Make the Waiting Visible](./make-the-waiting-visible.md) is about measuring the waiting between actions, which is where the lead time goes once the code itself is fast to write.
