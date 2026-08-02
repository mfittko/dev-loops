---
title: "The State Graph Is the Surface"
subtitle: "How dev-loops combines deterministic state machines, bounded agentic loops, and GitHub-backed evidence into one control plane for software delivery."
heroLede: "dev-loops does not ask an agent to remember the workflow. It models the workflow, derives the next legal move from authoritative state, and lets an agent, tool, or human execute one bounded transition at a time."
tags:
  - AI
  - Software Engineering
  - Developer Tools
  - Agentic Systems
  - State Machines
outro: closer
---

# The State Graph Is the Surface

> Start with [Introducing dev-loops](./introducing-dev-loops.md) for the product overview, [the deep dive](./dev-loops-deep-dive.md) for the operational mechanics, and [How dev-loops Decided Itself Into Shape](./how-dev-loops-decided-itself.md) for the decision history. This article places the same system in the wider loop- and graph-engineering landscape.

The vocabulary of agentic software development has moved quickly: prompt engineering, harness engineering, Ralph loops, Karpathy loops, graph engineering. Each term points at a real layer, but treating them as competing schools misses the more useful synthesis.

[The Ralph loop](https://ghuntley.com/ralph/) makes persistence external: run a bounded agent step, preserve durable artifacts, and start another iteration. [Karpathy's AutoResearch](https://github.com/karpathy/autoresearch) adds selection pressure: modify, evaluate against a fixed metric, keep the improvement or discard it, and repeat. Recent [graph-engineering](https://www.langchain.com/blog/3-years-of-graph-engineering-with-langgraph) discussions make the workflow topology explicit: deterministic paths where policy is known, agentic work where judgment is useful, and cycles where revision is expected.

`dev-loops` fits across all three, but its center of gravity is more specific:

> **dev-loops is a graph/loop control surface built around a modeled state graph.**

The graph models the state of the work and the legal moves from that state. The loop repeatedly observes the authoritative world, resolves the current state, selects one legal move, executes it, records the result, and refreshes. The public surface exposes that model as start, continue, inspect, steer, wait, approve, and merge behavior. GitHub supplies the current reference backend for tracked work, review evidence, CI, and terminal merge truth.

This distinction matters. The workflow does not live in a model's memory, a long prompt, or a chat transcript. Those are replaceable execution contexts. The durable product is the state model and the policy encoded around it.

## Where dev-loops fits

A useful way to position the repository is by the problem each pattern solves.

| Pattern | What it contributes | How dev-loops uses or extends it |
|---|---|---|
| Ralph loop | Persistence across repeated bounded agent runs | Re-entry is driven by freshly resolved state rather than by conversational continuity |
| Karpathy loop | Measured keep/discard selection | Review/fix convergence and retrospective follow-ups already create improvement loops; the modeled and testable control surface is a strong substrate for a future keep/revert meta-loop over workflow changes |
| Graph engineering | Explicit paths, branches, cycles, and deterministic control | The graph is state-first: it models the work, then projects the next actor and action, instead of starting from a static diagram of agents |
| Tracker/review backend | Durable identity, evidence, coordination, and terminal facts | GitHub issues, pull requests, reviews, threads, checks, head SHAs, and merge state form the current authoritative evidence plane |

The important qualification is that `dev-loops` is **not yet a general AutoResearch-style optimizer for its own orchestration**. It already self-corrects in flight and improves through review, retrospectives, follow-up issues, decision records, and tests. A fully automatic outer loop that proposes graph or harness changes, evaluates them on a held-out task suite, and keeps or reverts them would be an additional layer. The repository is unusually well prepared for that layer because its states, transitions, routing decisions, and traces are explicit and versioned.

## The reframe: from a graph of agents to a graph of work

Many agent frameworks begin with an execution graph:

- node A is a planner;
- node B is a coder;
- node C is a reviewer;
- an edge decides which agent runs next.

That is useful, but it makes the actors look more fundamental than the work.

`dev-loops` starts from the other direction. It models facts such as:

- which artifact is active;
- whether an issue has a linked pull request;
- whether the pull request is draft or ready;
- whether review threads are unresolved;
- whether CI is pending, failed, or green;
- whether gate evidence is visible and pinned to the current head;
- who owns the work and who must act next;
- whether the next mutation is authorized;
- whether the change is merged.

Pure interpreters map those facts to one current state, the allowed transitions, and a recommended next action. Routing then chooses the appropriate loop family, tool, agent role, wait behavior, or human handoff.

The actor is therefore a projection of the state, not the source of the workflow.

```mermaid
flowchart LR
  F[Authoritative facts<br/>GitHub + repository + runtime] --> I[Normalize and interpret]
  I --> S[Modeled current state]
  S --> R[Resolve legal next move]
  R --> A[Agent, tool, or human acts]
  A --> E[Evidence and state mutation]
  E --> F
```

*Diagram 1 — The state-backed control loop. Execution is always followed by a refresh from authoritative facts; no actor gets to carry stale state forward as truth.*

This is why the public `dev-loop` façade matters. A user expresses intent once. The surface resolves the target and current state, then routes to internal strategies without exposing them as competing user choices. The same state can be executed by a Claude Code plugin, a Pi extension, the CLI, a specialized agent, or a person without changing the workflow contract.

## The surface is a projection of modeled state

A control surface is more than a command list. It is the visible projection of what the model knows and permits.

The public state contract already exposes five dimensions:

| Dimension | Question it answers |
|---|---|
| `target` | What artifact is this run actually about? |
| `ownership` | Which durable owner or strategy family is responsible? |
| `nextActor` | Who is expected to make the immediate next move? |
| `status` | Is the work active, waiting, blocked, approval-ready, merge-ready, or done? |
| `authorization` | Is the next mutation `authorized`, `needs_confirmation`, or `not_authorized`? |

From those dimensions the system can project:

- the route kind;
- the selected internal strategy;
- the next action;
- the relevant gate;
- wait semantics and timeout policy;
- the stop or reconcile reason;
- the handoff envelope for the next worker;
- the evidence required to resume later.

This is the central reframe:

> **The user-facing graph/loop surface is generated from modeled state. It is not a second workflow layered on top of the state machine.**

Status, continuation, automation, steering, safe pauses, and human approval all become different views or transitions over the same underlying model.

## Nested graphs, one authoritative progression

The repository models the work at several resolutions.

### 1. The public graph

The public router resolves the active artifact, ownership, immediate actor, status, authorization, route kind, and execution mode. It answers the operator-level question: *what does `dev-loop` mean right now?*

### 2. The lifecycle graph

The outer lifecycle models the change from intake to merge:

```mermaid
stateDiagram-v2
  direction LR
  [*] --> IssueIntake
  IssueIntake --> Refinement
  IssueIntake --> Implementation
  Refinement --> IssueIntake
  Refinement --> Implementation
  Implementation --> DraftGate
  Implementation --> FeedbackResolution
  DraftGate --> Implementation
  DraftGate --> FeedbackResolution
  FeedbackResolution --> Implementation
  FeedbackResolution --> PreApprovalGate
  PreApprovalGate --> Implementation
  PreApprovalGate --> FeedbackResolution
  PreApprovalGate --> Merge
```

*Diagram 2 — The lifecycle is a cyclic state graph, not a one-way checklist. Failed gates and new evidence legitimately route the change back into implementation or feedback resolution.*

### 3. Family-local inner graphs

The Copilot and reviewer machines model finer states such as waiting for review, unresolved feedback, reply-and-resolve work, waiting for CI, review invalidation, convergence, and blocked conditions. UI review and other specialized loops add their own bounded subgraphs.

The conductor does not flatten those machines into one enormous prompt. It consumes their interpreted state and decides which family owns the next step. Each layer has a narrow authority boundary.

That is graph composition: not one giant diagram, but multiple state machines connected through explicit contracts.

## A loop is repeated state resolution

The word *loop* can make the system sound like an agent that simply keeps trying. The actual pattern is stricter.

```text
until terminal or human stop:
    snapshot = observe_authoritative_facts()
    state = interpret(snapshot)
    route = resolve_next_legal_move(state)
    result = execute_one_bounded_action(route)
    record(result)
    refresh()
```

The refresh is the important step. It prevents the executor from assuming that the world still matches the context it started with. A review may have arrived. CI may have failed. The head SHA may have changed. A human may have merged or closed the pull request. A steering instruction may have changed the allowed scope.

Each cycle therefore does three things:

1. **rebuild truth from the backend;**
2. **make one bounded move under the current policy;**
3. **return control to the state resolver.**

This is Ralph-like persistence with a stronger state discipline. The conversation can disappear because the next session can reconstruct the run from the same facts and contracts.

## GitHub is the reference evidence backend

GitHub is not merely where the resulting code is pushed. In the current implementation it plays several backend roles at once.

### Tracker

Issues identify work, carry the initial specification, record assignment, and link to the implementing pull request. Queue and sub-issue structures can model larger work trees.

### Review system

Pull-request reviews, pending reviews, comments, threads, replies, and resolution state make feedback observable. A comment is not just prose; it can be interpreted as an unresolved obligation, a resolved finding, a gate verdict, or a handoff.

### Verification ledger

Checks provide external evidence for CI state. Gate evidence can be pinned to the current head SHA so an older clean result cannot silently authorize a newer revision.

### Terminal truth

A merged pull request is a platform fact the agent cannot invent. That makes “done means merged” enforceable.

### Recovery substrate

A fresh run can inspect the issue, pull request, reviews, checks, current head, and durable comments to reconstruct what happened without replaying the original conversation.

```mermaid
flowchart TD
  T[Issue / plan<br/>identity + specification] --> P[Pull request<br/>change + head SHA]
  P --> R[Reviews and threads<br/>findings + obligations]
  P --> C[Checks<br/>verification evidence]
  R --> G[Gate decision]
  C --> G
  G --> M[Merge signal<br/>terminal truth]
  M --> X[Retrospective + follow-up issues]
  X --> T
```

*Diagram 3 — GitHub acts as a tracker, review backend, evidence ledger, and terminal source of truth. The conceptual boundary is a tracker/review backend; GitHub is the current reference implementation.*

The repository already contains a `Tracker` provider seam, with GitHub as the built-in default. The broader architectural point is that the state model consumes observable facts and emits routing decisions. A future backend can fit when it can supply equivalent identity, lifecycle, review, verification, and authorization signals without weakening the fail-closed guarantees.

## Deterministic policy around probabilistic workers

The system works because it does not ask deterministic code to perform judgment, and it does not ask a probabilistic model to enforce policy that can be encoded exactly.

| Deterministic state and policy | Agentic work | Human authority |
|---|---|---|
| Normalize snapshots | Refine an ambiguous request | Resolve genuine ambiguity |
| Interpret current state | Explore a repository | Approve policy exceptions |
| List legal transitions | Implement the accepted scope | Accept high-risk trade-offs |
| Enforce gate ordering | Review through a focused angle | Authorize merge by default |
| Verify head-pinned evidence | Fix the narrowest valid issue | Remain accountable for what ships |
| Fail closed to wait, stop, or reconcile | Summarize findings and propose follow-ups | Change the governing rules |

The result is neither a deterministic workflow that cannot adapt nor an unconstrained swarm that decides its own rules. It is a state machine that places model judgment inside bounded transitions.

## The same control model works in greenfield and brownfield repositories

The tool and skill set has already been used successfully in both greenfield and brownfield contexts. That is not an exception to the design; it follows from what the graph models.

The state graph models the lifecycle of a **change**, not the age of the codebase.

| Greenfield context | Brownfield context |
|---|---|
| Specification may begin as a local plan or new tracker item | Specification must include existing behavior, compatibility, and migration constraints |
| Architecture can be established during refinement | Existing architecture and ADRs constrain the valid implementation space |
| Tests are created with the feature | Existing tests, production behavior, and historical regressions become evidence |
| Scope often has fewer hidden dependencies | Context compilation and repository search are more important |
| Rollback may be simple | Rollout, data safety, and public-contract preservation may need stronger gates |

What changes is the context and the evidence bundle. What does **not** change is the control model:

- resolve authoritative state;
- select one legal move;
- isolate the work;
- verify against the applicable contracts;
- loop through feedback until convergence;
- stop at ambiguity or authorization boundaries;
- record terminal truth in the backend.

A brownfield repository does not require a different philosophy. It requires richer facts, stronger invariants, and more demanding gates. The same graph/loop surface can carry both.

## Self-correction today, self-improvement as the next layer

Two kinds of loop should remain distinct.

### Operational self-correction

The current system already handles in-flight correction:

- a failed or missing check becomes a visible state;
- unresolved review feedback routes back to fix/reply/resolve;
- a changed head invalidates stale evidence;
- the resolver re-derives the next action;
- bounded rounds prevent infinite review churn;
- ambiguous or contradictory state fails closed;
- a fresh session can resume from preserved evidence.

This loop improves the current change until it satisfies the gates.

### Workflow learning

The repository also improves its future behavior:

- grilling hardens a request before implementation;
- focused review angles expose recurring failure classes;
- retrospectives record advisory findings;
- the conductor can turn warranted findings into follow-up issues;
- architecture decisions preserve why a rule exists and when it was reversed;
- tests convert hard-won conventions into machine-enforced contracts.

This loop improves the process across changes.

```mermaid
flowchart LR
  subgraph Operational[Operational loop — current change]
    S[State] --> A[Bounded action]
    A --> V[Verification / review]
    V -->|finding or failure| S
    V -->|clean + authorized| M[Merge]
  end

  subgraph Learning[Learning loop — future changes]
    O[Traces + outcomes] --> F[Retrospective / decision]
    F --> Q[Follow-up issue or contract change]
    Q --> T[Test + new graph version]
    T --> O
  end
```

*Diagram 4 — The operational loop converges one change; the learning loop changes the system that will handle later changes.*

### A Karpathy-style meta-loop

The next logical extension is an evaluated outer loop over the control surface itself:

```text
propose a routing / prompt / model / gate / context change
    ↓
run old and candidate graph versions on held-out historical tasks
    ↓
measure correctness, review burden, cost, latency, and policy violations
    ↓
keep the candidate only when it improves within safety constraints
    ↓
otherwise revert
```

The evaluator must remain outside the candidate's control. Public benchmark scores alone would be too easy to game; the useful oracle is a private replay suite built from real repository tasks, escaped defects, review findings, and human correction effort.

`dev-loops` is a strong candidate for this mixture because the optimization target is not an opaque prompt. It is a versioned set of state models, transition tables, configuration, role mappings, gates, and handoff contracts that can be tested and compared.

## What the graph/loop surface buys

Once the state graph is treated as the primary product, several existing capabilities line up as consequences of the same design.

### Harness independence

Claude Code, Pi, and the CLI are adapters over shared routing and state logic. Models and harnesses can change without redefining the workflow.

### Safe resumption

A run can stop and later reconstruct state from authoritative facts. Long conversational memory is optional rather than load-bearing.

### Explainability

The system can report where the work is, why it routed there, what evidence it used, what it is allowed to do next, and why it stopped.

### Steering

A constraint or stop request can be applied at the next safe boundary because the surface knows which boundaries exist.

### Testability

A closed set of states and transitions can be unit-tested. Routing regressions become code failures instead of subtle changes in model behavior.

### Replaceable workers

An agent, deterministic tool, or human can execute a transition as long as it consumes and produces the expected contract. Capability can improve without moving policy back into the worker.

## What dev-loops is not

The reframe also clarifies the boundaries.

`dev-loops` is not:

- merely a shell loop that repeatedly invokes a coding model;
- a static DAG in which every node is a named agent;
- a multi-agent swarm whose conversation is the source of truth;
- a prompt that asks the model to remember gate order;
- a generic workflow DSL for every business process;
- already a fully automatic self-modifying graph optimizer.

It is a focused software-delivery control surface whose loops are traversals of explicit, testable state machines over a tracker and review backend.

## The resulting stack

The architecture can be summarized in six lines:

```text
GitHub                = durable work, review, and evidence backend
State interpreters    = projection from facts to current state
State-machine graphs  = legal lifecycle and recovery policy
Router / surface      = next actor, next action, wait, stop, approval
Loops                 = repeated observe → act once → refresh traversal
Agents/tools/humans   = replaceable executors inside bounded transitions
```

The learning layer sits across the stack: review outcomes, retrospectives, decision records, tests, and eventually an evaluated keep/revert loop for changes to the graph itself.

That is how `dev-loops` fits into the current agentic-development landscape. Ralph contributes persistence. Karpathy contributes measured selection. Graph engineering contributes explicit topology and control. `dev-loops` brings them together around the modeled state of a real software change, backed by a tracker and review system that preserves evidence between actors and between sessions.

The most important sentence is therefore not “the agent keeps going.” It is:

> **The state graph stays authoritative, and every loop comes back to it.**
