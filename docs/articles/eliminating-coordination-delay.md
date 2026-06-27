---
title: "Eliminating Coordination Delay in AI-Assisted Dev Workflows"
subtitle: "AI made writing code cheap. The handoffs around the code are where the hours go, and where agents guess wrong."
tags:
  - AI
  - Software Engineering
  - Developer Tools
  - Automation
  - Productivity
---

# Eliminating Coordination Delay in AI-Assisted Dev Workflows

An AI agent can write a working function in seconds. That part is solved. What is not solved is everything that happens *around* the function: handing it to a reviewer, getting feedback back to the author, waiting for the build, deciding whether it is safe to merge. Each of those handoffs looks instant on a diagram and takes hours in real life. Worse, an agent left to manage them on its own will guess at them. It assumes the build passed, assumes the review is done, and marks the work finished because finishing felt close.

That gap has a name: coordination delay. It is the time work spends waiting between people and steps, plus the rework caused when someone, or something, guesses wrong about where the work actually is. Code is cheap to write now; getting it through the pipeline is not.

This article is about one idea for closing that gap, and why the shape of the solution matters as much as the idea itself.

## The one idea: never guess a handoff

Here is the whole thing in a sentence: never guess a handoff. Make every handoff an explicit, observable decision.

That sounds modest, but most of the lost hours in an AI-assisted workflow are not lost inside the work. They are lost in the seams between steps, where the system has to answer a question like *who acts next?* or *is this ready?* and answers it with a hopeful assumption instead of a checked fact.

The fix is to refuse the assumption everywhere. Every transition (author to reviewer, reviewer back to author, ready-to-merge to merged) becomes a decision the system makes deliberately and writes down where you can see it. When the situation is ambiguous, the system does not pick the likeliest path and hope. It stops and asks. Ambiguity never becomes a guess without someone signing off on it.

Hold that rule and the work falls into loops nested inside loops. An outer loop asks, every cycle, *who acts next?*, then makes exactly one move before asking again. Inside it, one loop walks a single pull request from first draft to merged. Another tracks every review comment from raised to resolved, so nothing falls through. One move at a time, each move chosen on purpose.

```mermaid
stateDiagram-v2
  direction LR
  [*] --> WhoActsNext
  WhoActsNext --> WriteTheCode: author's turn
  WhoActsNext --> ResolveFeedback: reviewer's turn
  WhoActsNext --> AskAHuman: ambiguous
  WriteTheCode --> WhoActsNext
  ResolveFeedback --> WhoActsNext
  AskAHuman --> [*]
```

*Diagram 1 — The nested loops. An outer "who acts next?" decision routes each cycle to exactly one move, then returns to ask again. When the next step is ambiguous, the loop hands control to a human rather than guessing.*

## What an explicit handoff buys you

Treating every handoff as a real decision is not bureaucracy. It is what makes four behaviors possible that a guess-based workflow cannot offer.

The first is safe pauses. Because the system always knows where it is, it can stop without making a mess. Ask it to stop mid-edit and it does not drop a half-written file. It finishes the current step, lands it clean, and hands you a stopping point. There are only a few honest answers to "can I stop now?": stop this instant, stop at the next clean boundary, or I can't move at all because a required check is missing. The system gives you the true one.

The second is mid-flight steering. You can change the rules without stopping the machine. Halfway through a run you can say "don't touch the auth module," and that lands as a hard constraint the remaining steps must honor, with no restart and no lost progress. The rule takes effect from the next move on. A softer nudge becomes a preference the system honors when it can, and a "stop when safe" request winds the work down at the next clean boundary.

The third is parallel review that produces one verdict. Several reviewers examine a pull request at once, each on a different angle (scope, test coverage, security), and all of them read the *same evidence bundle*: the same diff, the same context. Because the inputs are identical, the verdicts are directly comparable, and they merge into a single answer. One serious finding blocks the merge.

The fourth matters most: "done" that means merged. In a guess-based system, "done" means the agent believes it is done. Here, the board shows done only when a pull request has actually merged, read from a real merge signal the agent cannot fabricate. The build being green is verified, not assumed, and the system waits for the real result. The agent never merges its own work. The final yes belongs to a named human, every time.

```mermaid
flowchart TD
  A[Draft opened] --> B{Draft gate:<br/>required checks present?}
  B -- no --> A
  B -- yes --> C[Review rounds]
  C --> D{Findings raised?}
  D -- yes --> E[Author resolves] --> C
  D -- no --> F{Pre-approval gate:<br/>CI verified green?}
  F -- not yet --> C
  F -- yes --> G[Hand to a named human]
  G --> H[Human merges]
  H --> I([Done = merged])
```

*Diagram 2 — A pull request's lifecycle through the gates. It cannot skip a gate that never ran: a draft with missing checks loops back, an unresolved finding returns to the author, and the merge belongs to a human, not the agent.*

## Fan out wide, fan in to one answer

The parallel review deserves a closer look, because it is a small pattern with a large payoff. Build the evidence once and neutrally (the diff plus just enough surrounding context) and hand that identical bundle to every reviewer. No reviewer gets a richer or poorer view than another, so their findings sit on the same footing. Then consolidate the separate verdicts into one, with the strictest finding winning.

```mermaid
flowchart LR
  E[One neutral<br/>evidence bundle] --> S[Scope review]
  E --> C[Coverage review]
  E --> Z[Security review]
  S --> V{Consolidate}
  C --> V
  Z --> V
  V --> O([One verdict<br/>strictest finding wins])
```

*Diagram 3 — Fan-out / fan-in. One evidence bundle fans out to independent reviewers working different angles in parallel, then their findings fan back in to a single consolidated verdict.*

Compare that to a free-for-all where each reviewer scrapes its own context and they end up arguing about different versions of reality. Here the input is shared, the angles run in parallel, and the output is one verdict you can trust.

## Steering without stopping

Mid-flight steering is worth one more diagram, because it shows the discipline in action. When you inject an instruction, the system does not obey on the spot. It classifies the instruction and decides *when* it can be honored safely.

```mermaid
flowchart TD
  I[Operator injects<br/>an instruction] --> K{Classify}
  K -- hard constraint --> S{Safe to apply now?}
  K -- preference --> P[Honor when possible]
  K -- stop when safe --> W[Wind down at<br/>next clean boundary]
  S -- yes --> A[Apply from next move on]
  S -- no --> Q[Queue until safe,<br/>then apply]
  A --> R([Run continues, steered])
  Q --> R
  P --> R
```

*Diagram 4 — Steering flow. A hard constraint is applied immediately if it is safe, or queued until the next safe point if it is not. The run keeps its progress either way, and is never left half-changed.*

## Why a state graph beats a prompt

You could try to get all of this from prompting alone: write a long, careful instruction and trust the model to follow it. It will, mostly, until it doesn't. Steer a workflow with prose and its behavior shifts with every model update, every longer context window, every change in sampling. The drift comes with no warning, and you find out in production.

Run the workflow on a state graph instead. The set of possible moves is closed and listable, so every next step is known up front. That buys two things prose cannot. A known set of moves is a testable set, so a wrong transition shows up in a test run rather than at 3 a.m. in production. And the system can always say exactly where it is and what it is allowed to do next, which is what makes safe pauses, steering, and an honest "done" possible at all.

A prompt is a wish about behavior. A state graph is a guarantee about it. When the whole point is to stop guessing, you do not want your coordination layer built on a guess.

## The close

AI made the code cheap. The coordination around the code is now the expensive part, and most of that cost is paid in bad handoffs: wrong routing, stalls nobody noticed, and a "done" that turns out to be a hope.

So stop guessing handoffs. Make every one of them a decision you can see: who acts next, whether it is safe to pause, what a mid-flight instruction means, and above all whether the work is actually merged or only assumed to be. Build that on a state graph so the guarantee holds even when the model underneath you changes.

Make every handoff a decision you can see, and nothing stalls in the dark.

---

## Rendering the diagrams on Medium

Medium does not natively render Mermaid. Each diagram above is written as a fenced `mermaid` block so it stays editable, and each carries a caption so the article reads cleanly even when a diagram is shown as a static image. To publish on Medium, either paste each block into a Mermaid-enabled editor (for example, the Mermaid Live Editor or any Markdown tool with Mermaid support) and embed the rendered image, or export each diagram as SVG/PNG and drop it in where the block sits. Because every diagram is captioned, the prose carries the argument on its own, and the diagrams reinforce it rather than carry it.
