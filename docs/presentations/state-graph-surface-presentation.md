---
theme: default
colorSchema: dark
title: "dev-loops: The State Graph Is the Surface"
info: How dev-loops combines deterministic state machines, bounded agentic loops, and GitHub-backed evidence
class: text-left
transition: slide-left
mdc: true
css: ./style.css
---

<div class="hero-card">
  <p class="kicker">dev-loops</p>
  <h1>The State Graph Is the Surface</h1>
  <p class="hero-copy">The workflow does not live in an agent's memory. dev-loops models the state of the work, derives one legal next move, and lets an agent, tool, or human execute that transition.</p>
  <div class="chip-row pt-5">
    <span class="pill">deterministic state</span>
    <span class="pill">bounded loops</span>
    <span class="pill">tracker + review evidence</span>
    <span class="pill">human authority</span>
  </div>
</div>

---

<p class="kicker">Where it fits</p>

## Three Ideas, One Control Surface

<div class="grid grid-cols-3 gap-5 items-stretch">
<div class="glass-card">
<p class="card-label">Ralph loops</p>
<ul class="mini-list">
  <li>Persist across repeated runs.</li>
  <li>Keep state in durable artifacts.</li>
  <li>Make one bounded move per cycle.</li>
</ul>
</div>
<div class="glass-card">
<p class="card-label">Karpathy loops</p>
<ul class="mini-list">
  <li>Evaluate every candidate.</li>
  <li>Keep improvements; revert regressions.</li>
  <li>Turn iteration into measurable search.</li>
</ul>
</div>
<div class="glass-card">
<p class="card-label">Graph engineering</p>
<ul class="mini-list">
  <li>Encode paths, branches, waits, and cycles.</li>
  <li>Mix deterministic and agentic nodes.</li>
  <li>Make control flow inspectable.</li>
</ul>
</div>
</div>

<div class="metric-card mt-5">
<p class="hero-copy"><strong>dev-loops composes all three around authoritative modeled state.</strong></p>
</div>

---

<p class="kicker">The reframe</p>

## Not a Graph of Agents — a Graph of Work

<div class="grid grid-cols-2 gap-5 items-start">
<div class="glass-card">
<ul class="tight-list">
  <li>The graph models the <strong>current state of the change</strong>.</li>
  <li>The surface projects the <strong>next actor, action, gate, wait, stop, or reconcile path</strong>.</li>
  <li>Agents are replaceable executors inside bounded transitions.</li>
  <li>Every action returns to authoritative facts before the next move.</li>
</ul>
</div>
<div class="glass-card">
<p class="card-label">The control cycle</p>

```mermaid {scale: 0.62}
flowchart LR
  F[Facts] --> S[State]
  S --> R[Legal move]
  R --> A[Actor]
  A --> E[Evidence]
  E --> F
```

</div>
</div>

---

<p class="kicker">Architecture</p>

## Five Planes, One Repeating Traversal

```mermaid {scale: 0.67}
flowchart LR
  B[Fact plane<br/>issue · PR · review · CI · repo] --> M[Model plane<br/>normalize · interpret · state]
  M --> C[Control plane<br/>route · gate · authorize · stop]
  C --> X[Execution plane<br/>agent · tool · human]
  X --> B
  B --> L[Learning plane<br/>traces · retrospectives · decisions · tests]
  L --> M
```

<div class="glass-card mt-5">
<p class="section-lead">The execution context can disappear. Backend evidence, state models, and contracts remain sufficient to reconstruct the next move.</p>
</div>

---

<p class="kicker">The public surface</p>

## The Surface Is Compiled from Modeled State

<div class="grid grid-cols-2 gap-5 items-start">
<div class="glass-card">
<p class="card-label">Canonical state dimensions</p>
<ul class="tight-list">
  <li><strong>target</strong> — which artifact is active?</li>
  <li><strong>ownership</strong> — which durable owner or strategy family is responsible?</li>
  <li><strong>nextActor</strong> — who must act now?</li>
  <li><strong>status</strong> — active, waiting, blocked, approval-ready, merge-ready, done?</li>
  <li><strong>authorization</strong> — permitted, needs confirmation, or forbidden?</li>
</ul>
</div>
<div class="glass-card">
<p class="card-label">Projected control surface</p>
<ul class="tight-list">
  <li>route kind and internal strategy</li>
  <li>next action and selected gate</li>
  <li>wait and timeout semantics</li>
  <li>stop or reconcile reason</li>
  <li>handoff envelope and required evidence</li>
</ul>
</div>
</div>

<div class="metric-card mt-5">
<p class="hero-copy">Start, continue, inspect, steer, wait, approve, and merge are views and transitions over the same model — not parallel workflows.</p>
</div>

---

<p class="kicker">Composition</p>

## One Public Surface, Nested State Graphs

<div class="grid grid-cols-3 gap-5 items-stretch">
<div class="glass-card">
<p class="card-label">Public graph</p>
<ul class="mini-list">
  <li>artifact + ownership</li>
  <li>status + authorization</li>
  <li>execution mode</li>
  <li>operator-visible next action</li>
</ul>
</div>
<div class="glass-card">
<p class="card-label">Lifecycle graph</p>
<ul class="mini-list">
  <li>issue intake</li>
  <li>refinement</li>
  <li>implementation</li>
  <li>draft gate</li>
  <li>feedback resolution</li>
  <li>pre-approval + merge</li>
</ul>
</div>
<div class="glass-card">
<p class="card-label">Inner graphs</p>
<ul class="mini-list">
  <li>Copilot review/fix</li>
  <li>reviewer fan-out/fan-in</li>
  <li>CI waits and retries</li>
  <li>UI validation</li>
  <li>specialized bounded loops</li>
</ul>
</div>
</div>

<div class="soft-note">The conductor composes state machines through contracts instead of flattening them into one giant prompt.</div>

---

<p class="kicker">Loop semantics</p>

## A Loop Is Repeated State Resolution

<div class="grid grid-cols-2 gap-5 items-start">
<div class="glass-card">
<pre><code>until terminal or human stop:
  snapshot = observe()
  state = interpret(snapshot)
  route = resolve(state)
  execute_one(route)
  record()
  refresh()</code></pre>
</div>
<div class="glass-card">
<ul class="tight-list">
  <li><strong>One bounded move</strong>, then control returns to the resolver.</li>
  <li>The refresh catches new reviews, CI changes, head changes, steering, merges, and closures.</li>
  <li>No worker carries stale assumptions forward as truth.</li>
  <li>Fresh sessions resume from facts, not conversational memory.</li>
</ul>
</div>
</div>

---

<p class="kicker">Backend</p>

## GitHub Is the Current Evidence Plane

<div class="grid grid-cols-3 gap-5 items-stretch">
<div class="glass-card">
<p class="card-label">Tracker + identity</p>
<ul class="mini-list">
  <li>work identity and spec</li>
  <li>assignment and queue</li>
  <li>issue ↔ PR linkage</li>
  <li>provider seam for issues/board</li>
</ul>
</div>
<div class="glass-card">
<p class="card-label">Review + verification</p>
<ul class="mini-list">
  <li>reviews and threads</li>
  <li>gate verdicts</li>
  <li>CI checks</li>
  <li>head-pinned evidence</li>
</ul>
</div>
<div class="glass-card">
<p class="card-label">Terminal truth + recovery</p>
<ul class="mini-list">
  <li>merged and closed are observable</li>
  <li>done cannot be fabricated</li>
  <li>fresh runs can reconstruct state</li>
  <li>durable comments preserve decisions</li>
</ul>
</div>
</div>

<div class="soft-note">The tracker seam is provider-pluggable for issues and boards. The PR, review, CI, and Copilot surface remains GitHub-coupled in v1.</div>

---

<p class="kicker">Division of responsibility</p>

## Determinism Sets Boundaries; Agency Does Work

<div class="grid grid-cols-3 gap-5 items-stretch">
<div class="glass-card">
<p class="card-label">Deterministic</p>
<ul class="mini-list">
  <li>normalize facts</li>
  <li>interpret state</li>
  <li>enforce transitions</li>
  <li>verify current-head evidence</li>
  <li>fail closed</li>
</ul>
</div>
<div class="glass-card">
<p class="card-label">Agentic</p>
<ul class="mini-list">
  <li>refine scope</li>
  <li>explore the repository</li>
  <li>implement</li>
  <li>review through a lens</li>
  <li>diagnose, fix, explain</li>
</ul>
</div>
<div class="glass-card">
<p class="card-label">Human</p>
<ul class="mini-list">
  <li>resolve ambiguity</li>
  <li>set policy</li>
  <li>accept high-risk trade-offs</li>
  <li>authorize merge by default</li>
  <li>remain accountable</li>
</ul>
</div>
</div>

---

<p class="kicker">Applicability</p>

## Same Control Model: Greenfield and Brownfield

<div class="grid grid-cols-2 gap-5 items-stretch">
<div class="glass-card">
<p class="card-label">Greenfield</p>
<ul class="tight-list">
  <li>Start from a local plan or new tracker item.</li>
  <li>Establish architecture during refinement.</li>
  <li>Create tests and implementation together.</li>
</ul>
</div>
<div class="glass-card">
<p class="card-label">Brownfield</p>
<ul class="tight-list">
  <li>Compile existing architecture, behavior, and history into the evidence bundle.</li>
  <li>Protect compatibility, migrations, data, and rollout.</li>
  <li>Use stronger regression and contract gates.</li>
</ul>
</div>
</div>

<div class="metric-card mt-5">
<p class="hero-copy"><strong>The toolset has already been used successfully in both contexts.</strong> Codebase age changes context and verification burden — not the state-backed control model.</p>
</div>
<div class="soft-note">The deferred Phase 7 second-repo pilot is a formal, reproducible portability proof; it is separate from operational evidence across greenfield and brownfield work.</div>

---

<p class="kicker">Learning</p>

## Two Loops Improve Different Things

<div class="grid grid-cols-2 gap-5 items-start">
<div class="glass-card">
<p class="card-label">Operational loop — current change</p>

```mermaid {scale: 0.58}
flowchart LR
  S[State] --> A[Act]
  A --> V[Verify]
  V -->|finding| S
  V -->|clean| M[Merge]
```

<p class="soft-note">Converges the current change through review, fix, retry, wait, and fail-closed recovery.</p>
</div>
<div class="glass-card">
<p class="card-label">Learning loop — future changes</p>

```mermaid {scale: 0.56}
flowchart LR
  T[Traces] --> D[Retrospective / decision]
  D --> Q[Follow-up / contract]
  Q --> G[Test + graph version]
  G --> T
```

<p class="soft-note">Turns outcomes into stronger contracts, tests, review lenses, and routing policy.</p>
</div>
</div>

---

<p class="kicker">Next layer</p>

## A Karpathy-Style Meta-Loop over the Surface

<div class="grid grid-cols-2 gap-5 items-start">
<div class="glass-card">
<ul class="tight-list">
  <li>Propose a change to routing, prompts, models, context, gates, or topology.</li>
  <li>Replay current and candidate graph versions on held-out real tasks.</li>
  <li>Measure correctness, review burden, latency, cost, and policy violations.</li>
  <li>Keep the candidate only when it improves inside fixed safety constraints.</li>
</ul>
</div>
<div class="glass-card">
<p class="card-label">Why dev-loops is a strong substrate</p>
<ul class="tight-list">
  <li>The optimization target is versioned and inspectable.</li>
  <li>States, transitions, gates, and traces are already testable.</li>
  <li>The evaluator can remain outside the candidate's control.</li>
  <li>Every accepted graph change can pass through the same PR evidence pipeline.</li>
</ul>
</div>
</div>

---

<p class="kicker">Takeaway</p>

## The State Graph Is the Product

<div class="grid grid-cols-2 gap-5 items-start">
<div class="glass-card">
<ul class="tight-list">
  <li><strong>The backend</strong> preserves durable work and evidence.</li>
  <li><strong>State machines</strong> define legal progression and recovery.</li>
  <li><strong>The surface</strong> projects status, next action, steering, waits, and approvals.</li>
  <li><strong>Loops</strong> repeatedly traverse the graph.</li>
  <li><strong>Agents, tools, and humans</strong> execute bounded transitions.</li>
</ul>
</div>
<div class="metric-card">
<p class="hero-copy">Ralph contributes persistence. Karpathy contributes measured selection. Graph engineering contributes explicit control.</p>
<p class="hero-copy"><strong>dev-loops brings them together around modeled state.</strong></p>
</div>
</div>

<div class="soft-note">The agent may change. The harness may change. The state graph stays authoritative, and every loop comes back to it.</div>

---

<p class="kicker">References</p>

## Sources and Repository Contracts

<div class="grid grid-cols-2 gap-5 items-start">
<div class="glass-card">
<p class="card-label">External framing</p>
<ul class="tight-list">
  <li><a href="https://ghuntley.com/ralph/">Geoffrey Huntley — Ralph</a></li>
  <li><a href="https://github.com/karpathy/autoresearch">Andrej Karpathy — AutoResearch</a></li>
  <li><a href="https://www.langchain.com/blog/3-years-of-graph-engineering-with-langgraph">LangChain — Three Years of Graph Engineering</a></li>
</ul>
</div>
<div class="glass-card">
<p class="card-label">dev-loops contracts</p>
<ul class="tight-list">
  <li><code>packages/core/src/loop/lifecycle-state.mjs</code></li>
  <li><code>skills/docs/public-dev-loop-contract.md</code></li>
  <li><code>skills/docs/pr-lifecycle-contract.md</code></li>
  <li><code>skills/docs/conductor-routing-contract.md</code></li>
  <li><code>skills/docs/tracker-seam-contract.md</code></li>
</ul>
</div>
</div>
