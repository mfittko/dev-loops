---
theme: default
colorSchema: dark
title: "dev-loops: Applied Process Observability"
info: How dev-loops eliminates coordination delay in AI-assisted dev workflows
class: text-left
transition: slide-left
mdc: true
css: ./style.css
---

<div class="hero-card">
  <p class="kicker">dev-loops</p>
  <h1>Eliminating Coordination Delay in AI-Assisted Dev Workflows</h1>
  <p class="hero-copy">A coordination runtime built on nested state machines. Every handoff is explicit, routed, and observable.</p>
</div>

---

<p class="kicker">Design Approach</p>

## State Graphs and Pure Functions, Not Prompt Engineering

<div class="grid grid-cols-2 gap-5 items-start">
<div class="glass-card">
<ul class="tight-list">
  <li>Workflow logic lives in <strong>skills</strong> backed by deterministic state machines</li>
  <li>Routing, gating, and handoff are pure functions — testable, reproducible</li>
  <li>LLM judgment is bounded: the graph decides <em>what happens next</em>, the agent decides <em>how</em></li>
</ul>
</div>
<div class="glass-card">
<ul class="tight-list">
  <li><strong>Prompt-only approach</strong>: behavior drifts with model updates, context length, temperature</li>
  <li><strong>Graph-backed skills</strong>: transitions are closed sets, outcomes are enumerable, regressions are catchable in CI</li>
</ul>
</div>
</div>

---

<p class="kicker">Loop Model</p>

## Three Nested Loops, Closed Transition Sets

<div class="glass-card">
<ul class="tight-list">
  <li><strong>Outer loop</strong> — selects one <code>ROUTING_OUTCOME</code> per cycle</li>
  <li><strong>Copilot loop</strong> — explicit lifecycle states from <code>no_pr</code> to <code>done</code>, including <code>pr_ready_no_feedback</code>, <code>waiting_for_copilot_review</code>, and <code>blocked_needs_user_decision</code></li>
  <li><strong>Reviewer loop</strong> — feedback resolution and re-request</li>
  <li>Ambiguity yields <code>needs_reconcile</code>, never a guessed handoff</li>
</ul>
</div>

```mermaid {scale: 0.68}
stateDiagram-v2
  direction LR
  [*] --> OuterLoop
  OuterLoop --> CopilotLoop: HANDOFF_TO_COPILOT_LOOP
  OuterLoop --> ReviewerLoop: HANDOFF_TO_REVIEWER_LOOP
  OuterLoop --> NeedsReconcile: ambiguous
  CopilotLoop --> OuterLoop: cycle complete
  ReviewerLoop --> OuterLoop: cycle complete
```

---

<p class="kicker">Quality Gates</p>

## Every State Transition Is an Explicit Gate

<div class="grid grid-cols-2 gap-5 items-start">
<div class="glass-card">
<ul class="tight-list">
  <li><code>no_pr → pr_draft</code> — work exists but is not reviewable</li>
  <li><code>pr_draft → pr_ready_no_feedback</code> — author signals readiness</li>
  <li><code>pr_ready_no_feedback → waiting_for_copilot_review</code> — review requested</li>
  <li><code>stop_at_next_safe_gate</code> requests a stop that takes effect at the next safe gate</li>
</ul>
</div>
<div class="glass-card">
<p><strong>SAFE_POINT_CATEGORY</strong></p>
<div class="chip-row">
  <span class="pill">immediate</span>
  <span class="pill">next_point</span>
  <span class="pill">terminal</span>
</div>
<p class="soft-note note-top-md">Each copilot-loop state maps to a safe-point category — the loop knows where it can safely pause for operator input.</p>
</div>
</div>

---

<p class="kicker">Conductor Routing</p>

## evaluateConductorRouting: One Deterministic Outcome Per Cycle

<div class="grid grid-cols-2 gap-5 items-start">
<div class="glass-card">
<ul class="tight-list">
  <li>Pure function — no I/O, no side effects</li>
  <li>Consumes family-local lifecycle states as inputs</li>
  <li>Returns exactly one <code>ROUTING_OUTCOME</code></li>
  <li>Conflicting signals → <code>needs_reconcile</code>, never a guess</li>
</ul>
</div>
<div class="glass-card">
<p><strong>ROUTING_OUTCOME</strong></p>
<div class="chip-row">
  <span class="pill">continue_current_wait</span>
  <span class="pill">handoff_to_copilot_loop</span>
  <span class="pill">handoff_to_reviewer_loop</span>
  <span class="pill">stay_with_current_live_owner</span>
  <span class="pill">stop_needs_human</span>
  <span class="pill">done_terminal</span>
  <span class="pill">needs_reconcile</span>
</div>
</div>
</div>

---

<p class="kicker">Parallel Reviews</p>

## Fan-Out Review Angles, Merge Into One Coherent Package

<div class="glass-card">
<ul class="tight-list">
  <li><code>determine_review_plan</code> — select bounded review angles</li>
  <li><code>reviews_running</code> — parallel local runs per angle</li>
  <li><code>merge_results</code> — combine findings into one review</li>
  <li><code>draft_review_ready</code> → <code>draft_review_posted</code> → <code>waiting_for_user_submit</code> → <code>submitted_review</code></li>
</ul>
</div>

```mermaid {scale: 0.6}
stateDiagram-v2
  direction LR
  determine_review_plan --> reviews_running
  reviews_running --> merge_results
  merge_results --> draft_review_ready
  draft_review_ready --> draft_review_posted
  draft_review_posted --> waiting_for_user_submit
  waiting_for_user_submit --> submitted_review
```

---

<p class="kicker">Steering</p>

## Operators Inject Constraints Mid-Flight Without Breaking the Loop

<div class="grid grid-cols-2 gap-5 items-start">
<div class="glass-card">
<ul class="tight-list">
  <li><code>stop_at_next_safe_gate</code> — requests a stop at the next safe gate</li>
  <li><code>hard_constraint</code> — must be respected by subsequent steps</li>
  <li><code>preference</code> / <code>clarification</code> — softer guidance</li>
  <li><code>next_point</code> states queue unsafe-now events; terminal states reject or require human action</li>
</ul>
</div>
<div class="glass-card">
<p><strong>STEERING_KIND</strong></p>
<div class="chip-row">
  <span class="pill">hard_constraint</span>
  <span class="pill">preference</span>
  <span class="pill">clarification</span>
  <span class="pill">stop_at_next_safe_gate</span>
</div>
<p class="soft-note note-top-sm">Result: <code>applied_now</code> · <code>queued_for_safe_point</code> · <code>rejected_unsafe_now</code> · <code>rejected_invalid_or_conflicting</code> · <code>needs_human_decision</code></p>
</div>
</div>

---

<p class="kicker">PR Lifecycle</p>

## PRs Flow Through a Deterministic Lifecycle

<div class="grid grid-cols-2 gap-5 items-start">
<div class="glass-card">
<ul class="tight-list">
  <li>Gate review comments are required (fail-closed) at draft and pre-approval boundaries</li>
  <li>Review threads are captured and resolved deterministically</li>
  <li>CI gates are checked before state transitions</li>
</ul>
</div>
<div class="glass-card">
<p><strong>Lifecycle checkpoints</strong></p>
<div class="chip-row">
  <span class="pill">draft_gate</span>
  <span class="pill">ready_for_review</span>
  <span class="pill">pre_approval_gate</span>
  <span class="pill">merge_ready</span>
</div>
</div>
</div>

---

<p class="kicker">Impact</p>

## Quality Up, Wait Time Down, Throughput Up

<div class="grid grid-cols-3 gap-5 items-start">
<div class="glass-card">
<p><strong>Quality ↑</strong></p>
<ul class="mini-list">
  <li>Routing refuses ambiguity</li>
  <li>Steering preserves operator intent</li>
</ul>
</div>
<div class="glass-card">
<p><strong>Wait time ↓</strong></p>
<ul class="mini-list">
  <li>Gate-review comments required at key boundaries</li>
  <li>CI and thread states drive lifecycle transitions</li>
</ul>
</div>
<div class="glass-card">
<p><strong>Throughput ↑</strong></p>
<ul class="mini-list">
  <li>Deterministic routing per cycle</li>
  <li>Blocked runs flagged before stall</li>
</ul>
</div>
</div>
