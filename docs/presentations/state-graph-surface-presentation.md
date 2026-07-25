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
    <span class="pill">GitHub evidence</span>
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
  <li>Keep context in durable artifacts.</li>
  <li>Make one bounded move per cycle.</li>
</ul>
</div>
<div class="glass-card">
<p class="card-label">Karpathy loops</p>
<ul class="mini-list">
  <li>Evaluate each candidate.</li>
  <li>Keep improvements, discard regressions.</li>
  <li>Turn iteration into search.</li>
</ul>
</div>
<div class="glass-card">
<p class="card-label">Graph engineering</p>
<ul class="mini-list">
  <li>Encode known paths and cycles.</li>
  <li>Mix deterministic and agentic steps.</li>
  <li>Make transitions inspectable.</li>
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
  <li>The surface projects the <strong>next actor, action, gate, wait, or stop</strong>.</li>
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

## Five Planes, One Loop

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
<p class="section-lead">The execution context can disappear. The state model, backend evidence, and contracts remain sufficient to resume.</p>
</div>

---

<p class="kicker">Composition</p>

## One Public Surface, Nested State Graphs

<div class="grid grid-cols-3 gap-5 items-stretch">
<div class="glass-card">
<p class="card-label">Public graph</p>
<ul class="mini-list">
  <li>target</li>
  <li>ownership</li>
  <li>next actor</li>
  <li>status</li>
  <li>authorization</li>
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
  <li>pre-approval</li>
  <li>merge</li>
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

<div class="soft-note">The conductor composes the machines through contracts instead of flattening them into one giant prompt.</div>

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
  <li>No worker is allowed to carry stale assumptions forward as truth.</li>
  <li>Fresh sessions resume from facts, not chat memory.</li>
</ul>
</div>
</div>

---

<p class="kicker">Backend</p>

## GitHub Is the Evidence Plane

<div class="grid grid-cols-3 gap-5 items-stretch">
<div class="glass-card">
<p class="card-label">Tracker</p>
<ul class="mini-list">
  <li>work identity</li>
  <li>specification</li>
  <li>assignment</li>
  <li>issue ↔ PR linkage</li>
</ul>
</div>
<div class="glass-card">
<p class="card-label">Review + verification</p>
<ul class="mini-list">
  <li>threads and resolutions</li>
  <li>gate verdicts</li>
  <li>CI checks</li>
  <li>head-pinned evidence</li>
</ul>
</div>
<div class="glass-card">
<p class="card-label">Terminal truth</p>
<ul class="mini-list">
  <li>merged is observable</li>
  <li>closed is observable</li>
  <li>done cannot be fabricated</li>
  <li>fresh runs can recover</li>
</ul>
</div>
</div>

<div class="metric-card mt-5">
<p class="hero-copy">GitHub is the current reference tracker/review backend — not merely a place to push the final diff.</p>
</div>

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
  <li>verify evidence</li>
  <li>fail closed</li>
</ul>
</div>
<div class="glass-card">
<p class="card-label">Agentic</p>
<ul class="mini-list">
  <li>refine scope</li>
  <li>explore the repo</li>
  <li>implement</li>
  <li>review through a lens</li>
  <li>fix and explain</li>
</ul>
</div>
<div class="glass-card">
<p class="card-label">Human</p>
<ul class="mini-list">
  <li>resolve ambiguity</li>
  <li>set policy</li>
  <li>accept risk</li>
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
  <li>Start from a plan or new tracker item.</li>
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
<p class="hero-copy"><strong>Codebase age changes the context and evidence — not the state-backed control model.</strong></p>
</div>

---

<p class="kicker">Learning</p>

## Two Loops Improve Different Things

<div class="grid grid-cols-2 gap-5 items-start">
<div class="glass-card">
<p class="card-label">Operational loop — today</p>

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
<p class="card-label">Meta-loop — natural next layer</p>

```mermaid {scale: 0.56}
flowchart LR
  T[Traces] --> P[Propose graph change]
  P --> E[Replay / evaluate]
  E --> K{Better?}
  K -->|yes| N[Keep]
  K -->|no| R[Revert]
```

<p class="soft-note">Optimizes routing, prompts, models, context, gates, and topology against held-out real tasks.</p>
</div>
</div>

---

<p class="kicker">Takeaway</p>

## The State Graph Is the Product

<div class="grid grid-cols-2 gap-5 items-start">
<div class="glass-card">
<ul class="tight-list">
  <li><strong>GitHub</strong> preserves durable work and evidence.</li>
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
