---
title: "dev-loops: A Deep Dive"
subtitle: "AI made writing code cheap. The hours now go into the handoffs around the code, and into the waiting between actions."
heroLede: "AI made writing code cheap. The hours now go into the handoffs around the code, author to reviewer, reviewer to CI, CI back to a human, and into the waiting between actions."
tags:
  - AI
  - Software Engineering
  - Developer Tools
  - Automation
  - Productivity
outro: closer
---

# dev-loops: A Deep Dive

> New here? Start with [Introducing dev-loops](./introducing-dev-loops.md) for the overview; this article is the deep dive beneath it.

An AI agent can write a working function in seconds. That part is solved. The hard part is everything that happens *around* the function: handing it to a reviewer, getting feedback back to the author, waiting for the build, deciding whether it is safe to merge. Each of those handoffs takes hours in real life, even when the diagram makes it look instant. An agent left to manage them on its own will guess at them. It assumes the build passed, assumes the review is done, and marks the work finished while those assumptions go unchecked.

That gap has a name: coordination delay. It is the time work spends waiting between people and steps, plus the rework caused when someone, or something, guesses wrong about where the work actually is. Code is cheap to write now, and the cost has moved into getting it through the pipeline.

This deep dive runs in two parts. The first part is about closing the gap: the next step is always known, so whoever is free pulls it from a state graph and the handoff turns optional. The second part is about the gap itself: the waiting between actions is where lead time goes now, and the reason it stays expensive is that nothing measures it.

# Part 1 — Eliminating coordination delay

## The one idea: the next step is always known

Here is the whole thing in a sentence: the next step is always known, like the next card on a Kanban board. The system computes the next action for any change at any time, and whoever is free pulls it from the visible state.

That sounds modest, yet it dissolves most of the lost hours in an AI-assisted workflow. Those hours live in the seams between steps, where someone usually has to package up context and hand it to the next actor, who then waits for that handoff to arrive. When the next action is already computed and on the board, the next actor reads it and pulls the work. The waiting-for-handoff disappears, because there is nothing left to wait to be handed.

The handoff turns optional, at most additive. When one happens it adds a note or extra context, and it stays a decision the system records where you can see it. It is no longer the load-bearing step the work blocks on. When the next action is ambiguous, the system stops and asks, and a human resolves it before the work moves on.

The work falls into loops nested inside loops. An outer loop asks, every cycle, *what is the next action here?*, then makes exactly one move before asking again. Inside it, one loop walks a single pull request from first draft to merged. Another tracks every review comment from raised to resolved, so nothing falls through. Every layer works the same way: read the next action, make one deliberate move, then ask again.

```mermaid
stateDiagram-v2
  direction LR
  [*] --> NextAction
  NextAction --> WriteTheCode: write the code
  NextAction --> ResolveFeedback: resolve feedback
  NextAction --> AskAHuman: ambiguous
  WriteTheCode --> NextAction
  ResolveFeedback --> NextAction
  AskAHuman --> [*]
```

*Diagram 1 — The nested loops. An outer "what is the next action here?" decision routes each cycle to exactly one move, then returns to ask again. When the next step is ambiguous, the loop hands control to a human.*

<!-- figure
      <div class="flow" role="img" aria-label="Nested loops: from Start the system repeatedly computes what the next action is — write the code, resolve feedback, or ask a human when ambiguous — then returns to that decision.">
        <div class="node start">Start</div>
        <div class="edge"><span class="arrow">&rarr;</span></div>
        <div class="node accent">What&nbsp;is&nbsp;the&nbsp;next&nbsp;action?</div>
        <div class="edge"><span class="arrow">&rarr;</span></div>
        <div class="flow-col">
          <div class="node">Write&nbsp;the&nbsp;code</div>
          <div class="node">Resolve&nbsp;feedback</div>
          <div class="node">Ask&nbsp;a&nbsp;human&nbsp;(ambiguous)</div>
        </div>
        <div class="edge"><span class="arrow">&rarr;</span><span class="edge-label">one move, then ask again</span></div>
        <div class="node accent">What&nbsp;is&nbsp;the&nbsp;next&nbsp;action?</div>
      </div>
-->

## What a known next step buys you

Computing the next action for any change makes four behaviors possible that a guess-based workflow cannot offer.

The first is safe pauses. Because the system always knows where it is, it can stop without making a mess. Ask it to stop mid-edit and it finishes the current step, lands it clean, and hands you a stopping point with the file intact. There are only two honest answers to "can I stop now?": stop at the next clean boundary, or not yet because a required check is missing. The system gives you whichever one holds.

The second is mid-flight steering. You can change the rules while the machine keeps running. Halfway through a run you can say "don't touch the auth module," and that lands as a hard constraint the remaining steps must honor; the run keeps its progress and applies the rule from the next move on. A softer nudge becomes a preference the system honors when it can, and a "stop when safe" request winds the work down at the next clean boundary.

The third is parallel review that consolidates into a single verdict. Several reviewers examine a pull request at once, each on a different angle (scope, coverage, input validation, among others), and all of them read the *same evidence bundle*: the same diff, the same context. Because the inputs are identical, the verdicts are directly comparable, and they merge into a single answer. One serious finding blocks the merge.

The fourth is the most important: "done" means merged. The board shows done only when a pull request has actually merged, read from the platform's own merge signal that the agent cannot fabricate. CI-green comes from the real check result, so the system waits for it before proceeding. And the merge itself is a human's call by default.

```mermaid
flowchart TD
  A[Draft opened] --> B{Draft gate:<br/>required checks present?}
  B -- no --> A
  B -- yes --> C[Review rounds]
  C --> D{Findings raised?}
  D -- yes --> E[Author resolves] --> C
  D -- no --> F{Pre-approval gate:<br/>CI verified green?}
  F -- not yet --> C
  F -- yes --> G[Human merges]
  G --> H([Done = merged])
```

*Diagram 2 — A pull request's lifecycle through the gates. Every gate must run before the next step: a draft with missing checks loops back, an unresolved finding returns to the author, and a human performs the merge.*

<!-- figure
      <svg viewBox="0 0 640 300" width="640" role="img" aria-label="A pull request's lifecycle through the gates">
        <defs>
          <marker id="ah" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="#94a3b8" />
          </marker>
        </defs>
        <g font-size="12">
          <rect x="20" y="20" width="150" height="40" rx="12" fill="#0f172a" stroke="#93c5fd" />
          <text x="95" y="44" text-anchor="middle">Draft opened</text>

          <rect x="20" y="100" width="150" height="48" rx="12" fill="#111827" stroke="#818cf8" />
          <text x="95" y="120" text-anchor="middle">Draft gate:</text>
          <text x="95" y="136" text-anchor="middle">checks present?</text>

          <rect x="245" y="100" width="150" height="40" rx="12" fill="#0f172a" stroke="#818cf8" />
          <text x="320" y="124" text-anchor="middle">Review rounds</text>

          <rect x="245" y="20" width="150" height="48" rx="12" fill="#111827" stroke="#a78bfa" />
          <text x="320" y="40" text-anchor="middle" class="lab">findings? author</text>
          <text x="320" y="56" text-anchor="middle" class="lab">resolves &amp; loops</text>

          <rect x="470" y="100" width="150" height="48" rx="12" fill="#111827" stroke="#818cf8" />
          <text x="545" y="120" text-anchor="middle">Pre-approval gate:</text>
          <text x="545" y="136" text-anchor="middle">CI green?</text>

          <rect x="470" y="200" width="150" height="40" rx="12" fill="#0f172a" stroke="#818cf8" />
          <text x="545" y="224" text-anchor="middle">Hand to a human</text>

          <rect x="245" y="200" width="150" height="40" rx="12" fill="#0f172a" stroke="#6ee7b7" />
          <text x="320" y="224" text-anchor="middle" style="fill:#6ee7b7">Done = merged</text>
        </g>
        <g stroke="#94a3b8" fill="none" stroke-width="1.4" marker-end="url(#ah)">
          <path d="M95,60 L95,100" />
          <path d="M170,124 L245,122" />
          <path d="M320,100 L320,68" />
          <path d="M395,120 L470,122" />
          <path d="M545,148 L545,200" />
          <path d="M470,220 L395,220" />
        </g>
        <g font-size="10" font-family="-apple-system, sans-serif">
          <text x="60" y="84" style="fill:#93c5fd">yes</text>
          <text x="408" y="114" style="fill:#93c5fd">verified</text>
          <text x="500" y="180" style="fill:#93c5fd">human merges</text>
        </g>
      </svg>
-->

## Fan out wide, fan in to one answer

The parallel review deserves a closer look, because it is a small pattern with a large payoff. Build the evidence once and neutrally (the diff plus just enough surrounding context) and hand that identical bundle to every reviewer. Every reviewer works from the same view, so their findings sit on the same footing. Then consolidate the separate verdicts into one, with the strictest finding winning.

```mermaid
flowchart LR
  E[One neutral<br/>evidence bundle] --> S[Scope review]
  E --> C[Coverage review]
  E --> Z[Input validation review]
  S --> V{Consolidate}
  C --> V
  Z --> V
  V --> O([One verdict<br/>strictest finding wins])
```

*Diagram 3 — Fan-out / fan-in. One evidence bundle fans out to independent reviewers working different angles in parallel, then their findings fan back in to a single consolidated verdict.*

<!-- figure
      <div class="flow" role="img" aria-label="Fan-out then fan-in: one neutral evidence bundle goes as the same diff to independent scope, coverage, and input-validation reviewers; the strictest verdict wins.">
        <div class="node start">One&nbsp;neutral<br/>evidence&nbsp;bundle</div>
        <div class="edge"><span class="arrow">&rarr;</span><span class="edge-label">same diff to each</span></div>
        <div class="flow-col">
          <div class="node">Scope&nbsp;review</div>
          <div class="node">Coverage&nbsp;review</div>
          <div class="node">Input&nbsp;validation&nbsp;review</div>
        </div>
        <div class="edge"><span class="arrow">&rarr;</span><span class="edge-label">consolidate</span></div>
        <div class="node accent">One&nbsp;verdict<br/>strictest&nbsp;wins</div>
      </div>
-->

A shared bundle keeps the angles aligned, because when each reviewer scrapes its own context they end up arguing about different versions of reality. With one input feeding every angle in parallel, the verdicts stay comparable and merge into a single answer you can trust.

## Steering without stopping

Mid-flight steering is worth one more diagram, because it shows the discipline in action. When you inject an instruction, the system classifies it and decides *when* it can be honored safely.

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

*Diagram 4 — Steering flow. A hard constraint is applied immediately when it is safe, or queued until the next safe point. The run keeps its progress either way and applies the change only at a clean boundary.*

<!-- figure
      <div class="flow" role="img" aria-label="Mid-flight steering: an operator instruction is classified as a hard constraint or a preference; a hard constraint applies from the next move or queues until safe, a preference is honored when safe.">
        <div class="node start">Operator&nbsp;injects<br/>an&nbsp;instruction</div>
        <div class="edge"><span class="arrow">&rarr;</span><span class="edge-label">classify</span></div>
        <div class="flow-col">
          <div class="node accent">Hard&nbsp;constraint</div>
          <div class="node">Preference</div>
          <div class="node">Stop&nbsp;when&nbsp;safe</div>
        </div>
        <div class="edge"><span class="arrow">&rarr;</span><span class="edge-label">safe now?</span></div>
        <div class="flow-col">
          <div class="node">Apply&nbsp;from&nbsp;next&nbsp;move</div>
          <div class="node">Queue&nbsp;until&nbsp;safe</div>
        </div>
        <div class="edge"><span class="arrow">&rarr;</span></div>
        <div class="node accent">Run&nbsp;continues,<br/>steered</div>
      </div>
-->

## Why a state graph beats a prompt

You could try to get all of this from prompting alone: write a long, careful instruction and trust the model to follow it. It will follow it most of the time, then drift without warning. Steer a workflow with prose and its behavior shifts with every model update, every longer context window, every change in sampling. That drift surfaces in production.

Run the workflow on a state graph. The set of possible moves is closed and listable, so the resolver can compute the one next action for any change and surface it. This is what makes the next step always known and pullable: the next actor reads the current state and takes the move waiting there, with no handoff to wait for. It buys two things prose alone cannot. A known set of moves is a testable set, so a wrong transition shows up in a test run before it reaches production. And the system can always say exactly where it is and what it is allowed to do next, which is what makes safe pauses, steering, and an honest "done" possible at all.

A state graph guarantees the behavior a prompt can only request. When the next step has to be knowable at any moment, the coordination layer itself should rest on something checkable.

# Part 2 — Make the waiting visible

Closing the handoffs is half the work. The other half is the gap itself. A change that used to take an afternoon now lands in seconds. The diff shows up before you've finished reading the request. Generation, the part we spent decades trying to speed up, is now fast enough to be routine.

Then the work sits. It sits while someone notices it's ready. It sits while a reviewer rebuilds enough context to have an opinion. It sits in a queue, waiting for the one person who knows whether the next step is safe. The code is written in seconds, and the change ships hours later. Almost none of that gap shows up anywhere you'd think to look.

The waiting between actions is where your lead time goes now, and it's the most expensive part of delivery precisely because nothing measures it. The fix starts with measurement, and there's a cheap, concrete way to begin.

## One interrupt costs five transitions

A "quick question" costs far more than the minute it takes to answer. The real cost is the chain it sets off: you notice the request, switch away from what you were doing, rebuild the mental state for the new thing, act on it, and then recover by climbing back into the work you abandoned and reconstructing where you were. Each link in that chain has its own latency, and most of that latency is pure overhead.

```mermaid
flowchart LR
  A[Need response] --> B[Notice]
  B --> C[Switch]
  C --> D[Rebuild state]
  D --> E[Act]
  E --> F[Recover]
```
*Diagram 5 — The interrupt-cost chain. A five-minute question triggers five transitions, and the answer itself is only one of them.*

<!-- figure
      <div class="flow" role="img" aria-label="Interrupt cost: one interruption forces five transitions — Notice, Switch, Rebuild state, Act, then Recover — before the original work resumes.">
        <div class="node start">Need&nbsp;response</div>
        <div class="edge"><span class="arrow">&rarr;</span></div>
        <div class="node">Notice</div>
        <div class="edge"><span class="arrow">&rarr;</span></div>
        <div class="node">Switch</div>
        <div class="edge"><span class="arrow">&rarr;</span></div>
        <div class="node accent">Rebuild&nbsp;state</div>
        <div class="edge"><span class="arrow">&rarr;</span></div>
        <div class="node accent">Act</div>
        <div class="edge"><span class="arrow">&rarr;</span></div>
        <div class="node">Recover</div>
      </div>
-->

The five minutes of answering is the small box in the middle. The notice, switch, rebuild, and recover are the tax, and both sides of the exchange pay it. Across a queue of work, these costs multiply. Each handoff is an interrupt for whoever receives it, so a backlog of pending handoffs is a backlog of context switches waiting to happen.

## Every handoff restarts the same discovery from scratch

The same pattern repeats one level up, at the handoff.

When work crosses from one actor to another, the receiver starts an investigation: what changed since they last looked, whether they have enough context to act with confidence, who owns this now, and what's blocking it. When any of that is unclear, they ask, and you've paid for a round trip before any real work happens.

```mermaid
flowchart LR
  Q[Receiver asks] --> A[Sender answers]
  A --> C[Receiver confirms]
  C --> W[Work resumes]
  W -. next ambiguity .-> Q
```
*Diagram 6 — One handoff round trip. Every question the state can't answer becomes an ask → answer → confirm cycle, and the work waits until it closes — then the next ambiguity restarts it.*

<!-- figure
      <div class="flow" role="img" aria-label="Handoff round trip: Receiver asks, Sender answers, Receiver confirms, work resumes — then the cycle repeats on the next ambiguity.">
        <div class="node start">Receiver&nbsp;asks</div>
        <div class="edge"><span class="arrow">&rarr;</span></div>
        <div class="node">Sender&nbsp;answers</div>
        <div class="edge"><span class="arrow">&rarr;</span></div>
        <div class="node">Receiver&nbsp;confirms</div>
        <div class="edge"><span class="arrow">&rarr;</span></div>
        <div class="node accent">Work&nbsp;resumes</div>
        <div class="edge dashed"><span class="arrow">&#8630;</span><span class="edge-label">next ambiguity</span></div>
        <div class="node start">Receiver&nbsp;asks</div>
      </div>
-->

A mix of humans and AI agents makes it worse. Ambiguous ownership pauses a human until they ask. Missing context halts an agent, which either guesses and leaves you the cleanup or stops cold. Every human-to-agent and agent-to-human swap is one more place the state can drop on the floor. "More hands make it faster" holds only when the state survives each handoff intact, and any boundary it can fall through quietly cancels the gain you were counting on.

## The bottleneck is where human attention goes

The tools can show the wait. GitHub timestamps every transition; a pull request's timeline reveals exactly how long it sat between "CI passed" and "someone acted." The waiting is visible, when you choose to look.

The cost is not concealment — it is the routing. Getting work from "ready" to "shipped" runs through human attention, and attention has two failure modes. It is often not immediately available: the person who can act is in a meeting, context-switched onto something else, or on the other side of a timezone. That unavailability is where the stall lives. And when attention is available, spending it on mechanical coordination — noticing a status update, confirming a CI result, deciding a branch is safe to merge — crowds out the work only a person can do: shaping the product, setting the right review bar, staying accountable for what ships.

The drag on lead time is not that the tooling cannot see the wait. It is that routing routine transitions through human attention makes those transitions dependent on attention's availability — and pulls that attention away from the judgment-heavy decisions where it is irreplaceable.

## Four fields get the next actor moving

More meetings and status pings are themselves interrupts. The fix is making the state of the work explicit, so picking it up becomes a continuation of work already in motion.

Four fields carry most of that state:

- **Who owns it now**, so nobody guesses whose move it is.
- **What's blocking it**, and what would unblock it.
- **The latest decision**, so nobody re-litigates settled ground.
- **The safe next step**, the one move known to be safe to take.

Keep these four current and the next actor, human or agent, starts right away. The reconstruction is already written down, ready to read. The investigation that every handoff used to trigger collapses into a glance.

## Measure the wait first

Explicit state does more than speed up the next pickup. It turns the waiting into something you can measure, and measurement is what lets you shorten it.

Once you capture state at each transition, the waits between actors turn into numbers you can point at, in place of anecdotes like "review felt slow this sprint." From there you can run a real loop: find the transition that stalls the most, change the process at exactly that point, and check whether the wait dropped. Then confirm the change held quality steady, which is the step people skip once a wait finally drops.

```mermaid
flowchart LR
  A[Capture state] --> B[Measure waits]
  B --> C[Change the process]
  C --> D[Verify outcomes]
  D --> A
```
*Diagram 7 — The measurement loop. Capture, measure, change, verify — then back to capture. It repeats as a cycle, because the slowest transition moves as you fix things.*

<!-- figure
      <div class="flow" role="img" aria-label="Measurement loop: Capture state, Measure waits, Change the process, Verify outcomes — then loop back to capture.">
        <div class="node start">Capture&nbsp;state</div>
        <div class="edge"><span class="arrow">&rarr;</span></div>
        <div class="node">Measure&nbsp;waits</div>
        <div class="edge"><span class="arrow">&rarr;</span></div>
        <div class="node accent">Change&nbsp;the&nbsp;process</div>
        <div class="edge"><span class="arrow">&rarr;</span></div>
        <div class="node">Verify&nbsp;outcomes</div>
        <div class="edge"><span class="arrow">&#8635;</span><span class="edge-label">back to capture</span></div>
        <div class="node start">Capture&nbsp;state</div>
      </div>
-->

This is ordinary improvement discipline, applied to the part of delivery that has stayed invisible. Shortening a wait depends on measuring it, and measuring it depends on capturing its state.

## Those four fields already live in the work

"Make the state explicit" is more concrete than "write better tickets": each of the four fields maps onto a mechanism that already does the work when you let it.

**Owner and safe next step are a board.** Work moves through visible columns: waiting, in progress, done. The column carries the current owner and the safe next step, so a glance at it tells you both. A deterministic resolver picks the next action from the board's state, so "whose move is it?" has one settled answer.

**The latest decision leaves a trail.** Each review gate records its verdict in the open, with the findings that justified it attached. The decision lives written down, where it survives past the moment someone logs off. Pick the work up tomorrow and the reasoning is still there, right where the verdict was.

**Automation runs only where the state proves it's safe.** Handle the wait at CI by waiting on the real result, the actual check status from whatever provider runs it. After a merge, finished workspaces get reclaimed and long-done items get archived. Each of those automations is gated on state that says continuing is safe. The judgment stays human while the waiting in between gets handled automatically.

```mermaid
flowchart TD
  S[Observable state] --> B[Board lifecycle]
  S --> G[Gate evidence trail]
  S --> R[Next-action resolver]
  B -->|owner + safe next step| O[Next actor starts immediately]
  G -->|latest decision + findings| O
  R -->|whose move it is| O
  O --> C[CI wait + post-merge reclaim run only where state says safe]
```

*Diagram 8 — Grounding "observable state" in real mechanisms. The board carries owner and next step, the gate trail carries the latest decision, the resolver answers whose move it is, and safe automation runs on that confirmed state.*

<!-- figure
      <svg class="tree-svg" viewBox="0 0 640 360" role="img" aria-label="Observable state feeds the board, gate trail, and resolver, which let the next actor start and let safe automation run.">
        <defs>
          <marker id="ah2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
            <path d="M0,0 L7,3 L0,6 Z" fill="rgba(148,163,184,0.85)" />
          </marker>
        </defs>
        <rect x="230" y="14" width="180" height="46" rx="13" fill="rgba(24,36,61,0.92)" stroke="rgba(167,139,250,0.7)"/>
        <text x="320" y="42" text-anchor="middle" font-size="15" style="fill:#ddd6fe">Observable state</text>
        <rect x="22" y="118" width="180" height="58" rx="13" fill="rgba(24,36,61,0.92)" stroke="rgba(129,140,248,0.4)"/>
        <text x="112" y="143" text-anchor="middle" font-size="13">Board lifecycle</text>
        <text x="112" y="162" text-anchor="middle" font-size="11" class="lbl">owner + safe next step</text>

        <rect x="230" y="118" width="180" height="58" rx="13" fill="rgba(24,36,61,0.92)" stroke="rgba(129,140,248,0.4)"/>
        <text x="320" y="143" text-anchor="middle" font-size="13">Gate evidence trail</text>
        <text x="320" y="162" text-anchor="middle" font-size="11" class="lbl">latest decision + findings</text>

        <rect x="438" y="118" width="180" height="58" rx="13" fill="rgba(24,36,61,0.92)" stroke="rgba(129,140,248,0.4)"/>
        <text x="528" y="143" text-anchor="middle" font-size="13">Next-action resolver</text>
        <text x="528" y="162" text-anchor="middle" font-size="11" class="lbl">whose move it is</text>
        <rect x="150" y="232" width="340" height="50" rx="13" fill="rgba(24,36,61,0.92)" stroke="rgba(147,197,253,0.6)"/>
        <text x="320" y="262" text-anchor="middle" font-size="14" style="fill:#93c5fd">Next actor starts immediately</text>
        <rect x="120" y="316" width="400" height="40" rx="13" fill="rgba(17,24,39,0.82)" stroke="rgba(167,139,250,0.55)"/>
        <text x="320" y="341" text-anchor="middle" font-size="12.5" style="fill:#ddd6fe">CI wait + post-merge reclaim run only where state says safe</text>
        <path d="M285,60 L130,116" stroke="rgba(148,163,184,0.85)" fill="none" marker-end="url(#ah2)"/>
        <path d="M320,60 L320,116" stroke="rgba(148,163,184,0.85)" fill="none" marker-end="url(#ah2)"/>
        <path d="M355,60 L510,116" stroke="rgba(148,163,184,0.85)" fill="none" marker-end="url(#ah2)"/>
        <path d="M120,176 L240,230" stroke="rgba(148,163,184,0.85)" fill="none" marker-end="url(#ah2)"/>
        <path d="M320,176 L320,230" stroke="rgba(148,163,184,0.85)" fill="none" marker-end="url(#ah2)"/>
        <path d="M520,176 L400,230" stroke="rgba(148,163,184,0.85)" fill="none" marker-end="url(#ah2)"/>
        <path d="M320,282 L320,314" stroke="rgba(167,139,250,0.7)" fill="none" marker-end="url(#ah2)"/>
      </svg>
-->

These are the same mechanisms from Part 1, read from the other side. The board, the gates, and the resolver carry the four fields latent in the work, ready to surface. Making them explicit stops them from leaking.

## The close

AI made the code cheap, and the coordination around it is now the expensive part. Most of that cost is paid in bad handoffs: wrong routing, stalls nobody noticed, and a "done" that was only assumed. The rest is paid in the waiting between actions, which stays expensive because nothing measures it.

So make the next step always known, and measure the waits. Compute the next action for any change and put it on the board, so whoever is free pulls it. Once the next action is visible, the rest follows from it: who acts next, whether it is safe to pause, what a mid-flight instruction means, and above all whether the work has actually merged. A handoff still happens when someone adds a note, and it stays a decision you can see. Build that on a state graph so the guarantee holds even when the model underneath you changes. Then capture state at each transition so the biggest stall shows up in plain numbers, and automate only where the state proves it's safe.

The next agent will write your code in seconds. The lever you control is the coordination around it: keep the next step known so the next actor pulls it, and measure how long the work waits.
