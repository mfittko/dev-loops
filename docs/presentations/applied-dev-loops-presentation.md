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
  <p class="hero-copy">AI agents made writing code cheap. The handoffs around the code — author to reviewer, reviewer to CI, CI back to a human — are where hours quietly leak and where agents guess wrong. dev-loops turns every handoff into a decision you can see.</p>
</div>

---

<p class="kicker">The core idea</p>

## Loops Inside Loops

<div class="grid grid-cols-2 gap-5 items-start">
<div class="glass-card">
<ul class="tight-list">
  <li><strong>Who acts next?</strong> An outer loop decides, every cycle, which role takes the work — and makes exactly one move at a time.</li>
  <li><strong>The PR's life.</strong> An inner loop walks each pull request from first draft to merged, one explicit step at a time.</li>
  <li><strong>The feedback.</strong> A second inner loop tracks every review comment from raised to resolved, so nothing gets lost.</li>
  <li>When the situation is ambiguous, it stops and asks. <em>Ambiguity never becomes a guess.</em></li>
</ul>
</div>
<div class="glass-card">
<p class="card-label">One move per cycle</p>

```mermaid {scale: 0.66}
stateDiagram-v2
  direction LR
  [*] --> WhoActsNext
  WhoActsNext --> WriteTheCode: author's turn
  WhoActsNext --> ResolveFeedback: reviewer's turn
  WhoActsNext --> AskAHuman: ambiguous
  WriteTheCode --> WhoActsNext
  ResolveFeedback --> WhoActsNext
```

</div>
</div>

---

<p class="kicker">Safe pauses</p>

## Pauses Only at Safe Boundaries

<div class="grid grid-cols-2 gap-5 items-start">
<div class="glass-card">
<ul class="tight-list">
  <li><strong>Pause now</strong> — it's safe to hand control to a human this instant.</li>
  <li><strong>Pause at the next clean boundary</strong> — finish the step in flight first, then stop.</li>
  <li><strong>Can't continue</strong> — a required check is missing, so the work refuses to move.</li>
  <li>A pull request <em>cannot</em> advance past a review that was never actually run. The gate fails closed.</li>
</ul>
</div>
<div class="glass-card">
<p class="card-label">Example</p>
<p class="soft-note">You ask it to stop. If it's mid-edit, it doesn't drop the file — it tags the request <code>stop_at_next_safe_gate</code> and pauses the moment the current step lands clean. You get a tidy stopping point, not a half-written change.</p>
</div>
</div>

---

<p class="kicker">Mid-flight steering</p>

## Change the Rules Mid-Run

<div class="grid grid-cols-2 gap-5 items-start">
<div class="glass-card">
<ul class="tight-list">
  <li><strong>A hard rule</strong> — a constraint the next steps must obey.</li>
  <li><strong>A preference</strong> — a nudge it tries to honor when it can.</li>
  <li><strong>A question</strong> — a clarification it folds into its next move.</li>
  <li><strong>Stop when safe</strong> — wind down at the next clean boundary.</li>
</ul>
</div>
<div class="glass-card">
<p class="card-label">Example</p>
<p class="soft-note">Halfway through, you say <em>"don't touch the auth module."</em> It lands as a <code>hard_constraint</code> the remaining steps must honor — no restart, no lost progress, the rule simply takes effect from the next move on.</p>
</div>
</div>

---

<p class="kicker">Parallel review</p>

## Many Reviewers, One Verdict

<div class="grid grid-cols-2 gap-5 items-start">
<div class="glass-card">
<ul class="tight-list">
  <li>Every reviewer reads the <strong>same evidence bundle</strong> — the same diff, the same context — so their verdicts are directly comparable.</li>
  <li>Each looks from a different angle (scope, test coverage, security) at the same time.</li>
  <li>The findings merge into <strong>one verdict</strong>.</li>
  <li>A single serious finding <em>blocks the merge</em> — one no is enough.</li>
</ul>
</div>
<div class="glass-card">
<p class="card-label">Same evidence in, one verdict out</p>

```mermaid {scale: 0.6}
stateDiagram-v2
  direction LR
  Evidence --> Scope
  Evidence --> Coverage
  Evidence --> Security
  Scope --> Verdict
  Coverage --> Verdict
  Security --> Verdict
```

</div>
</div>

---

<p class="kicker">It never lies about being done</p>

## "Done" Means Merged

<div class="grid grid-cols-3 gap-5 items-start">
<div class="glass-card">
<p class="card-label">A human merges</p>
<ul class="mini-list">
  <li>The agent never merges its own work.</li>
  <li>At the final gate it hands the PR to a named person.</li>
  <li>A human always owns the last yes.</li>
</ul>
</div>
<div class="glass-card">
<p class="card-label">"Done" is real</p>
<ul class="mini-list">
  <li>The board shows <em>done</em> only when a PR actually merged.</li>
  <li>It reads a real merge signal — it can't fabricate one.</li>
  <li>Each task runs in its own isolated workspace.</li>
</ul>
</div>
<div class="glass-card">
<p class="card-label">Green is checked</p>
<ul class="mini-list">
  <li>CI-green is verified, never assumed.</li>
  <li>Works with any CI provider, not just one.</li>
  <li>It waits for the real result instead of guessing.</li>
</ul>
</div>
</div>

---

<p class="kicker">Why a graph, not a prompt</p>

## State Graphs Pin Behavior

<div class="glass-card">
<ul class="tight-list">
  <li>Steer a workflow with prose alone and its behavior shifts with every model update, longer context, or change in temperature — quietly, with no warning.</li>
  <li>dev-loops runs the workflow on a <strong>state graph</strong> instead: the moves are a closed, listable set, so every possible next step is known up front.</li>
  <li>A known set of moves is a testable set — a wrong transition is caught in CI, not in production at 3am.</li>
</ul>
</div>

---

<p class="kicker">Impact</p>

## Stop Losing Afternoons

<div class="grid grid-cols-2 gap-5 items-start">
<div class="glass-card">
<ul class="tight-list">
  <li><strong>Because routing refuses to guess,</strong> you don't lose an afternoon to a wrong handoff that quietly sent the work the wrong way.</li>
  <li><strong>Because every pause is explicit,</strong> stalls that used to sit until someone happened to check are flagged the moment they happen.</li>
  <li><strong>Because "done" means merged,</strong> a green board is the truth, not a hopeful guess.</li>
</ul>
</div>
<div class="glass-card">
<p class="hero-copy">Make every handoff a decision you can see — and nothing stalls in the dark.</p>
</div>
</div>
