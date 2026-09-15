# Finding the flow

*Loops, graphs, and more reliable AI agents*

Audience: company-wide; no programming knowledge assumed. Timing: 48 minutes of explanation, a 2-minute audience exercise, and 10 minutes for questions: 60 minutes total. Slides 1–34 take 50 minutes including the exercise; slide 35 stays up during questions. [Open the deck](finding-the-flow.html). Use arrow keys, Page Up/Down, or Space; Home/End jumps. Links keep normal keyboard behavior. The HTML opens offline and uses no external assets. Browser print offers a landscape PDF; the HTML is the primary deliverable.

## Running order

| Section | Slides | Time |
| --- | --- | --- |
| Foundations: steps, state, guards | 1–6 | 6:45 |
| Worked traces, spec changes and recovery | 7–13 | 11:00 |
| Bounded freedom and parallel checks | 14–16 | 5:00 |
| dev-loops: routing, job cards and nested reviews | 17–22 | 9:30 |
| Actual UI sub-loop used for this deck | 23–25 | 4:30 |
| dev-loops: evidence, waits and authority | 26–29 | 7:00 |
| Audience exercise and answer | 30–31 | 3:00 |
| Limits, evaluation, close | 32–34 | 3:15 |
| Questions, with sources on screen | 35 | 10:00 |

Follow the highlighted arrows. The customer diagrams show three states of the same process; slide 11 applies invalidation to an authorized acceptance-criteria change in dev-loops. Values and retry budgets are teaching examples; no production logs are shown. The public router's five fields are a useful vocabulary; actual decisions also depend on validated evidence and settings.

## Pitch

AI agents improvise. Sometimes they skip a step or declare success too soon. A predefined workflow gives them strict guardrails: checks they must pass, steps they must redo when something goes wrong, and boundaries that fail closed when they can't safely continue. This talk explores how loops and graphs make those rules enforceable, so reliable results depend less on the agent following oh-so-sophisticated prompts.

## 1. Finding the flow — 0:45

“I want to talk about the part of AI work that happens between asking for something and believing it's done.”

For this talk, an agent is an AI system that can use tools and take actions across several steps. It might look up an order, draft a response, run a check, and decide what to do next. We are interested in the process around those actions.

What must happen before the system is allowed to treat the work as complete? The title is about finding that process and making it explicit.

## 2. “Done.” According to whom? — 1:00

Use a hypothetical example: “You ask an agent to prepare a customer reply and check the order details first. It produces a very plausible answer. Did it actually check?”

A detailed prompt can say that the check is mandatory. If the same agent also decides whether it has obeyed the prompt, we are still depending on its interpretation. This is an architectural distinction: instructions tell the model what to do; executable checks and permissions decide whether an action is allowed.

Prompts shape the quality of work within a step. Mandatory process rules also need executable checks and permissions.

## 3. The arrows are rules — 1:30

Walk across the diagram. A node is a step that does work. An edge is an allowed transition between steps. A guard is a condition that must hold before that transition can happen.

State is the record used to make the decision: the current draft, its version, the facts retrieved, the check result, and who has approved it. That record should survive the current chat session when the process needs to resume later.

The backward arrow is essential. “Check failed” routes to revision, then a new check. The controller requires this route before the work can advance.

Sources: [W3C SCXML](https://www.w3.org/TR/scxml/) specifies transition conditions; [LangGraph Graph API](https://docs.langchain.com/oss/python/langgraph/graph-api) describes state, nodes, and edges. The displayed three-step graph is our teaching example.


## 4. The graph remembers facts — 1:00

Point to the difference between the work record and the control record. The draft and the retrieved order data describe what is being worked on. Validation, attempt count, and approval describe what the system is permitted to do with it.

The illustrative record says version B failed validation and has no approval. That makes “send” unavailable even if B looks polished. The next step can be computed from the check outcome and the remaining repair budget. The responsible tool or controller should record these values. A drafting model's assertion alone is insufficient evidence.

State persists only the facts needed for this process; it need not preserve every thought or the full chat transcript. Keep the record small and explicit.

## 5. A transition is a small contract — 1:30

Zoom into just one arrow: approve → send. Its contract identifies the exact work and recipient, the evidence required, and the authority needed. The sending service checks that contract when called.

After executing, it records what actually happened. There is a meaningful distinction between “send attempted,” “delivery confirmed,” and “delivery status unknown.” If a network failure leaves the outcome unknown, reconcile the delivery status before deciding whether to retry.

Ask rhetorically: “If I draw this arrow on a whiteboard but leave the agent another unrestricted send tool, what did I enforce?” The answer is nothing at that alternate action boundary. This is why the graph and the tool permissions have to agree.

This is an illustrative action contract. The source ideas are guarded state transitions, fail-secure action boundaries, and safe retry semantics, covered by the W3C, OWASP, and AWS references in the research companion.

## 6. Put agents inside established workflows — 1:00

This borrows from long-established state machines and workflow systems. The new part is having probabilistic model work inside a process we want to control.

There is actual material using the phrase “graph engineering”: a July 2026 LangChain practitioner article and an August 2026 survey preprint. Their scope is broader than this talk. It includes dynamic graphs, agent coordination, and evolving task structures. We are selecting one useful part: defined workflow boundaries, recovery, and evidence.

Workflow graphs organize what work may happen next. Knowledge graphs and GraphRAG organize information and relationships for retrieval. Ordinary code can implement a small state machine with a single agent and no framework.

Sources: [3 Years of Graph Engineering with LangGraph](https://www.langchain.com/blog/3-years-of-graph-engineering-with-langgraph), 22 July 2026; [Feng et al.](https://arxiv.org/abs/2608.21156), recent preprint. These sources offer emerging terminology and practitioner framing. They establish neither a settled standard nor comparative proof.

## 7. Check and approve before sending — 1:00

This customer-service process is a teaching example. It has not been deployed as company policy. The customer asks about an order. The agent receives the order facts and drafts a reply. Validation checks the fields we can check against the system of record, such as the order identifier and recipient. A person approves the exact draft before it is sent.

Suppose the agent used an old delivery date. Validation rejects the draft and returns the mismatched field. The workflow sends the work back for repair, then runs validation again. If the order system is unavailable, the workflow cannot establish that the draft matches the order. It must wait or escalate until the required facts are available.

The drafting agent has no direct send permission. A separate action boundary checks that the required evidence and approval exist for that version. An unrestricted alternate send tool bypasses this boundary.

Structured field checks validate only the specific facts they cover. Subjective tone, implications, and unusual requests may need a person or a fallible model-based evaluator.


## 8. Follow the happy path — 1:30

Introduce the diagram once. The top row is draft → validate → human approval → guarded send. Lower branches represent repair and recovering unavailable facts. Cyan nodes and edges show the current trace; the muted routes remain available when their conditions are met.

Read the state snapshot: draft A, validation passed for A, approval names A. The send guard now has the facts it needs. The agent completed its work, and a person's recorded approval authorized the send.

Walk one arrow at a time. The draft-ready event permits validation; the passing result permits asking for approval; the person's recorded decision permits the guarded send. These are different facts from different producers.

This demonstrates that the stipulated checks and authority precede the action. Reply quality remains dependent on the checks' coverage. The system still needs good checks for the facts and risks that matter.

## 9. A failed check sends it back — 2:00

Keep the same graph on screen so the audience can see what changed: only the observed state and the highlighted route.

The validator compares the order date in draft A with the order record and returns a specific mismatch. That failed result makes the route to approval unavailable. The controller dispatches repair with the mismatch as feedback.

The agent creates B. B is new work; it has no passing validation merely because A was checked. Follow the return arrow to a fresh validation. Count the attempt in the controller's state. The “1 of 3” budget introduced earlier is illustrative; a real budget depends on risk, time, and cost.

The feedback names the defect, the work changes, the check runs again, and the loop has an exit.

## 10. Unknown takes another arrow — 2:00

The order service is unavailable, so validation cannot establish whether the date is right. Validation returns unknown because the facts are unavailable. Sending remains unavailable while the workflow recovers those facts.

Follow the unknown branch to recover facts. If the service returns within the remaining budget, follow the facts-restored arrow back to validation. If attempts or elapsed time run out, follow the handover branch. A human can resolve missing information or choose another authorized path; the workflow does not silently lower its requirements.

Distinguish a known external wait from unknown process state. We may know a check is running and safely wait for it. If we cannot establish which work is active or whether an action occurred, we first reconcile those facts.

Recovery needs a budget chosen for the process; there is no universal retry count. AWS's retry guidance supports budgets, backoff, and care around overloaded services.

## 11. Changed criteria require fresh clearance — 1:00

Acceptance criteria (ACs) say what the work must satisfy. Move from the customer example to an actual dev-loops rule: during development, a person authorizes a material change from criteria v1 to v2 and records that decision on the canonical tracker artifact.

The developer agent may propose a change or escalate an ambiguity. It cannot authorize a rewrite, weakening, or reinterpretation of those criteria to make its implementation pass. After a human authorizes the spec change, the implementation must earn fresh clearance against the new criteria.

The new authoritative criteria produce a new `specDigest`, independently of the code's `headSha` and `contentDigest`. The code can be unchanged while every approval, disposition, fixer authorization, carry-forward decision, and gate result derived from the old spec becomes stale. Re-evaluate the existing implementation against v2. Rewrite it only where the new criteria require changes.

This differs from an implementation-only change under the same spec. There, affected or unproven criterion approvals become stale; unaffected approvals can carry only with positive proof that their spec text and covered implementation surface are unchanged. Formatting-only edits preserving the normalized authoritative spec are not material AC changes.

Source: [Immutable spec-authority contract](https://github.com/mfittko/dev-loops/blob/9b5f988e/skills/docs/spec-authority-contract.md), “Human-only spec change,” and `resolveCriterionInvalidation` in `packages/core/src/loop/spec-authority.mjs` (lines 512–553). A changed spec digest returns the full prior-approved set as stale and no carried criteria. This enforcement seam implements the authority contract. Tool credentials may still permit edits to tracker text. <!-- secret-scan:allow source link pinned to inspected repository commit -->

## 12. Advancement requires evidence. — 1:30

Explain “fail closed” in ordinary terms: if we cannot establish permission, we do not perform the protected action. The three outcomes are pass, fail, and unknown/error.

The difference matters because real checks crash, external services time out, and records disappear. Those failures must not fall through a default “continue” branch. A crashed check leaves the required evidence unavailable.

Recovery can continue: restore the evidence, retry a temporary read failure, or ask a person. The transition requiring the missing proof stays closed.

Source: [OWASP Fail Securely](https://community.owasp.org/Fail_securely) is a security principle about error paths and permission. We apply that principle to quality gates as a design analogy. OWASP provides no certification of agent correctness here.

## 13. “Try again” needs a reason — 2:00

There are different failure types, and each deserves a different arrow.

A temporary outage may justify waiting and retrying the same call, with a limit on attempts or elapsed time. A bad draft needs changed work informed by feedback. Missing information may require a person. If the process exhausts its budget, it stops and hands over.

The subtle case is a timeout after sending. The sender may have succeeded even though the caller never received the confirmation. Repeating the action blindly could send the message twice. Reconcile with the external system, or use an operation identifier that makes repeating the request safe. Engineers call that property idempotency: retrying the same intended action does not create another effect.

The workflow owns the counter and stop route, which persist across conversations. Useful feedback and observable progress matter when evaluating a retry loop's effect on reasoning.

Sources: [AWS retry limits](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_mitigate_interaction_failure_limit_retries.html) and [Making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/). Recovery taxonomy is our synthesis. [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) also warns about replayed side effects on resume.


## 14. Define where the agent can choose — 1:30

An investigation can be open-ended within a node: search several sources, compare hypotheses, choose useful tools, and draft an answer. The outside workflow still controls whether the work can advance, consume more budget, or perform a protected action.

If a model chooses every next edge, placing those edges in a graph has not made those choices deterministic. Code can enforce a restricted set of choices and mandatory checks; the model can exercise judgment within that set.

For very simple tasks, one model call and a validator may be enough. Extra graph structure should earn its place by making a real dependency, recovery path, or authority boundary explicit.

Sources: [Anthropic workflow/agent patterns](https://www.anthropic.com/engineering/building-effective-agents); [LangChain graph engineering](https://www.langchain.com/blog/3-years-of-graph-engineering-with-langgraph). The latter explicitly discusses full agents inside nodes and where rigid paths are a poor fit.


## 15. Parallel work still needs a join — 2:00

Introduce the second graph shape. Three independent checks can inspect the same version at the same time. In this example they cover facts, policy, and destination. “Fan out” starts those branches. “Fan in” gathers their outcomes.

If each check sees a different draft or a different order record, their results may not describe one coherent candidate. A bundle gives the branches a common starting point. Each check can still make mistakes.

A join is an actual decision boundary. It needs a declared list of required outcomes, version identity, and valid result formats. It can then evaluate the results according to the workflow's policy. A model-based policy check remains a model judgment even when its result format is valid.

Parallelism is optional. Use it when the checks are genuinely independent and the saved wait outweighs the coordination cost.

## 16. Two passes and a missing check — 1:30

Ask the audience to decide before reading the answer: “Two passed. One never returned. Are we done?”

No: the recipient check was required and its outcome is absent. The workflow cannot treat silence as approval. It can recover that missing result, rerun a safe check within its budget, or stop. It cannot average the three outcomes.

All required checks must have accountable outcomes. Policy determines which findings block. A policy can classify some findings as advisory. Completeness and severity are separate questions. This distinction becomes concrete in the dev-loops review round.

## 17. Apply it to AI development — 1:30

“dev-loops is where I've been applying these ideas to software development.”

For non-developers: a pull request is the shared record proposing a change to software. Automated tests, review findings, and approval attach to that record. Merge accepts the proposed change into the main codebase. Deployment to customers is a separate step.

The diagram simplifies the lifecycle: define the work, implement it, pass a draft gate, work through review and repairs, then establish pre-approval evidence. There are returns from findings to repair. Waiting for an external check is a state too.

Each cycle, the outer router re-reads the artifact and derives the next route from current state. A resumed run continues from those facts.

Source snapshot: [public routing contract](https://github.com/mfittko/dev-loops/blob/9b5f988e/skills/docs/public-dev-loop-contract.md) and [routing implementation](https://github.com/mfittko/dev-loops/blob/9b5f988e/packages/core/src/loop/public-dev-loop-routing.mjs). <!-- secret-scan:allow source links pinned to inspected repository commit -->


## 18. What does the router know? — 1:00

Translate the five fields. Target is the active work record. Ownership is lasting responsibility. Next actor is who should act now. Status describes the current condition. Authorization records whether the action is allowed.

Ownership and next actor can differ. Copilot may own implementation while a reviewer needs to act next. That distinction avoids treating “owned by Copilot” as “Copilot should always do the next thing.”

The example pull-request number is invented for teaching. Real routing also consumes evidence and policy settings. It selects the next action from explicit, validated state.

Source: public routing contract and `packages/core/src/loop/public-dev-loop-routing.mjs` at the inspected revision.

## 19. One state, one next action — 1:00

Read three rows: blocked or unauthorized stops; a known external wait routes to wait/watch; reviewer-next routes to the review/fix strategy. The order of these rules matters when several facts could appear relevant.

The “ready” row catches a common shortcut. In dev-loops, a readiness label is not a substitute for explicit, visible, clean pre-approval evidence for the current revision. Green automated checks and resolved discussion threads do not replace that gate record.

If target identity or family-local state is malformed or missing, reconciliation happens before routing. That is different from healthy waiting: we cannot select a justified route until we know what state we are in.

Sources: `routeForState` in public-dev-loop-routing.mjs and `evaluateConductorRouting` in conductor-routing.mjs. The displayed cases illustrate selected routes. The implementation contains the complete routing logic.

## 20. Give the worker a job card — 2:00

Use the job-card analogy: a worker needs to know which work item is active, what to read, what action to take, and what evidence to return. They also need the stopping rules.

dev-loops derives that handoff envelope from resolved state and settings. The named fields include `nextAction`, `requiredReads`, `stopRules`, and acceptance criteria. This reduces the amount of workflow the worker must reconstruct from a long conversation.

A fresh session can receive the contract and continue the bounded job. Malformed or contradictory handoff structures are rejected by validation. Volatile evidence still needs refreshing near the action.

The card gives the worker instructions, which it can misunderstand. Runtime guards must enforce permission at protected actions.

Source: `buildDevLoopHandoffEnvelope` and its validator in `packages/core/src/loop/handoff-envelope.mjs`.

## 21. A loop can contain another loop — 2:00

Trace the outside rectangle: observe current facts, resolve a route, perform a bounded action, refresh. On the next cycle, the router evaluates the new state again.

Now point inside the action. “Handle the review” can contain its own review-and-repair loop. It has a narrower goal and its own budget. A successful inner step returns evidence to the outer loop. Later actions still require their own permission checks.

This conceptual diagram groups work across multiple functions. The repository contains multiple state machines and coordination layers. `outer-loop.mjs` interprets Copilot and reviewer state, calls conductor routing, and persists the checkpoint. The public router and lifecycle guards supply additional boundaries.

The value of nesting is scale: the outer process remains understandable while a complex job uses its own bounded mechanics.

## 22. A review round has an output contract — 2:00

Zoom into the inner loop. A current evidence bundle carries the scope and revision to the required review lenses. A dispatch unit can cover several review lenses.

The join is layered. First, coverage checks establish whether the required review outcomes are present. Then result artifacts and revision identity are validated. Finally, findings are consolidated using the configured blocking threshold. Missing or malformed required evidence blocks; a clean outcome may contain nonblocking observations.

`consolidateFanin([])` alone can return clean. The separate expected-coverage checks in the CLI and coverage functions establish whether an empty or partial set is permissible. The coverage checks and consolidation must run together.

After required evidence is complete, the mandatory judge phase produces scope/relevance dispositions and the deterministic bridge derives the fixer's act list. The judge phase is mandatory even when consolidation returns clean. Only findings classified for action go to repair; other dispositions can defer or reject a finding. A repair creates a new revision; refreshed evidence and the required reviews/gates follow. If budget is exhausted, the workflow must stop or escalate.

Sources: `packages/core/src/loop/gate-fanin.mjs`, `checkFanoutAngleCoverage`, `checkResolvedAngleEvidence`, the sanctioned fan-in CLI, and the gate-review sub-loop contract. The diagram summarizes the intended composition. Reviewers can still make mistakes.


## 23. How this presentation was built — 2:00

This presentation provides the example. During preparation, the implementing agent authored the HTML and ran the shared browser suite. The parent agent inspected screenshots and returned visual findings. Those two agents performed the design and review roles within this collaboration.

The browser renders the current HTML. Automated checks measure viewport fit, accessibility, runtime errors, and keyboard navigation. Visual review inspects the actual diagram, including the meaning of the highlighted paths. Findings return to the author, who repairs the relevant presentation content and produces a fresh render.

The initial 33-slide expanded draft passed all six browser tests. Visual review still found hidden arrow labels, an incorrect active branch, and a return path crossing a nested-loop callout.

Explain the sub-loop boundary: the outer task remains “prepare the talk.” The narrower UI job is “make the current slides readable and diagrammatically correct under the stated checks.” The author repeats that job until the results are ready to return to the outer task.

## 24. Visual review caught errors in the graph — 1:30

Show the embedded earlier screenshot. The state snapshot says two waits remain, but the first diagram highlighted the exhausted-budget handover too. That incorrectly suggests the current run is already taking the handover branch.

The reviewer also found “draft ready” and “approved” labels partly hidden by adjacent nodes. We shortened them to fit the edge gaps. In the outer-loop drawing, the return line passed behind the inner-loop box; moving the box and using a dashed containment connection separated return flow from nesting.

These review findings were corrected in the later draft. The screenshot preserves the earlier, faulty version as evidence of the preparation process.

The successful automated tests and the visual findings answer different questions. Passing layout checks establishes geometric fit under those assertions. Graph meaning needs a separate visual review.

## 25. Exit on evidence for the current render — 1:00

Turn the observed collaboration into a reusable workflow contract. Every edit requires a fresh render. Required automated and visual results must be present. Actionable findings return to the author, while the outer process waits for the sub-loop result and then refreshes its state.

The retry-budget row proposes an automatic cap. This preparation session had no configured automatic cap. To enforce it, a real controller would need to count attempts and block another round at the limit until an authorized decision.

Likewise, the actual visual review here was an agent inspecting screenshots in conversation. The review relied on conversational judgment, without a runtime validator enforcing final approval. This slide adds proposed control rules to the observed workflow.

“Clean” means no remaining actionable findings within the selected checks and review scope. Taste remains subjective, and audience members may still misunderstand a slide.


## 26. Each revision needs current evidence — 2:00

Give a short trace: tests fail on revision A. An agent repairs the code, producing revision B. The earlier evidence cannot establish that B is ready. The required pre-approval record must identify B.

The code uses a revision identifier called the head SHA. In `buildPreMergeGateCheck`, the pre-approval verdict must be visible, complete, clean, and match the current head. The draft gate also needs a visible clean verdict. This function imposes the current-head match on pre-approval evidence only.

The merge wrapper compares the head read for the action against the evidence head. It also pins the actual merge command to that revision, so a push between checking and merging cannot silently substitute a newer version.

The unreadable-review example has precise scope: when the size/risk approval rule needs review information, a reviews-read failure must not become “zero unresolved objections.” It blocks that required decision. The sanctioned merge wrapper also treats missing prerequisite evidence as failure. Mechanical coverage varies across actions and harnesses.

Sources: [detect-checkpoint-evidence.mjs, `buildPreMergeGateCheck`](https://github.com/mfittko/dev-loops/blob/9b5f988e/scripts/github/detect-checkpoint-evidence.mjs#L373); [merge-pr.mjs, head check and pinned merge](https://github.com/mfittko/dev-loops/blob/9b5f988e/scripts/github/merge-pr.mjs#L233). Code inspected at commit `9b5f988e`. <!-- secret-scan:allow source links pinned to inspected repository commit -->


## 27. Waiting survives the conversation — 1:30

An external test or review may take longer than a chat session. A checkpoint records enough identity and interpreted state to reattach: which repository, which work record, which revision, and what wait was in progress.

On resumption, use that checkpoint to find the work, then refresh authoritative facts. A review that arrived after the checkpoint updates the current state. A newer revision can invalidate the old conclusion.

The outer-loop code preserves carried wait-cycle state only with matching identity and revision conditions. It distinguishes continuing a known wait from stopping on inconsistent state. Our diagram explains the intention; actual waiting mechanics and enforcement vary by layer and harness.

Sources: `scripts/loop/outer-loop.mjs`, conductor-routing.mjs, and the public startup/resume contract.

## 28. Publishing requires separate authorization — 1:30

Evidence and authority answer different questions. Checks say which conditions were established. Human approval and authorization say whether the action may happen. The default lifecycle retains those decisions even when the technical evidence is clean.

The supported merge wrapper evaluates prerequisites and refuses when they fail. There are configured policy variations and explicitly scoped standing-authorization modes. This diagram shows the default conceptual path. The authorization interaction varies across supported modes.

The project has deterministic runtime checks, procedural rules, and harness-specific hooks. Some hooks are optional; some shell operations remain convention-enforced. Bypasses require attention to actual credentials, tools, and repository protections. The case study demonstrates enforcement at the named boundaries.

Sources: [merge preconditions](https://github.com/mfittko/dev-loops/blob/9b5f988e/skills/docs/merge-preconditions.md), [merge evaluator](https://github.com/mfittko/dev-loops/blob/9b5f988e/packages/core/src/loop/merge-approval.mjs), [main-agent enforcement coverage](https://github.com/mfittko/dev-loops/blob/9b5f988e/skills/docs/main-agent-contract.md). <!-- secret-scan:allow source links pinned to inspected repository commit -->


## 29. The merge checks the actual version — 2:00

Read the table as two alternative branches, each with two steps.

First branch: the wrapper reads candidate A, but the evidence read returns B because a new push landed. The mismatch fails the precondition, so the process must read and assess the current revision again.

Second branch: candidate and evidence both match A. The wrapper pins the merge command to A with `--match-head-commit`. If B appears before the merge runs, that command refuses the unchecked replacement.

This closes a timing gap between observing permission and executing the action. It still relies on the behavior of the underlying merge API and configured repository protections. These checks apply within the sanctioned wrapper. Other tools or credentials may bypass that boundary.

Source: `scripts/github/merge-pr.mjs`, head mismatch comparison and version-pinned merge invocation.

## 30. Which arrow is allowed? — 2:00

Give people 60 seconds with a neighbor, then take two or three answers. Ask them to name the missing fact and the next permitted step.

A: the draft is ready, but the check timed out. B: a person approved A, while the current draft is B. C: all checks pass, but publishing has not been authorized.

Leave this slide up during discussion. The next slide is the answer reveal; no interactive simulator or network connection is required. This two-minute block is included in the 50-minute content slot.

## 31. A pause can be the correct result — 1:00

A needs evidence recovery within a budget. B needs validation and approval for the current version. C needs an authorized decision.

Point out that all three can be productive next steps even though none publishes the work immediately. The workflow preserves the distinction between doing more work, learning what happened, and obtaining authority.

If someone proposes “ask another AI,” ask what evidence or permission that answer could actually establish. Another AI can offer a second opinion. Authorization still requires the person's decision.

## 32. What do these checks establish? — 1:00

Under the same rules, the same validated inputs can lead to the same permitted transition. Prose and tool responses can still vary, and output correctness requires separate evaluation.

A check can be incomplete. A model-based reviewer can make the same mistake as the author. A workflow can encode the wrong policy. The claim is more control over the process and better evidence about what happened, with output reliability still something to measure.

For questions about self-correction: [Huang et al., ICLR 2024](https://arxiv.org/abs/2310.01798) found limitations in intrinsic self-correction without external feedback for the models/tasks studied. It motivates external feedback within the models and tasks studied. Its findings cannot be generalized to all current models.

## 33. Test the wrong turns — 1:30

Ask what would happen if the required check vanished. Then change the artifact after approval. Then simulate a timeout after an external action. The important test is whether the implementation takes the safe route when the happy path breaks.

Verify success against actual outcomes in the environment. Did the message send to the intended person, once, after the approved checks? Across repeated tasks, record success and failure, policy escapes, human handovers, time, and cost. Keep task difficulty and definitions stable when comparing workflow versions.

The dev-loops evidence presented here covers concrete process mechanisms and regression checks. This talk presents no measured before/after reliability improvement; an improvement percentage would require an experiment.

Source: [Anthropic, Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), 9 January 2026. It distinguishes traces from environment outcomes and repeated-trial evaluation.

## 34. Make the next step depend on evidence — 0:45

“Pick a process you already know. Draw the steps. At each arrow, ask what must be true before we move on. Then draw what happens when it isn't.”

Start with one meaningful boundary. Decide how to recover, when to stop, and who can authorize the final action. Let the agent remain useful inside that process.

End on the user's line: “Let reliable results depend less on the agent following oh-so-sophisticated prompts.” Pause for questions.

## 35. Further down the graph — appendix / questions

Leave this on screen during questions. The [research companion](finding-the-flow-research.md) maps each external source to supported claims, presentation use, and caveats. All links are primary material; the survey is explicitly a recent preprint. The dev-loops links pin the inspected source revision so the cited evidence remains reproducible.

## Questions to expect

- **Isn't this just workflow automation?** Much of the control structure is. The interesting engineering work is deciding where probabilistic judgment belongs, what evidence to demand, and how recovery behaves when the work or the environment changes.
- **Do we need LangGraph?** No. It provides useful graph and persistence primitives; a small process can use ordinary code. Framework selection depends on actual needs.
- **Does fail closed mean more interruptions?** It can. Unknown evidence stops protected advancement. Measure whether those stops catch important failures or reveal checks that need a better recovery path.
- **Can the agent change the workflow?** It can propose a change, but policy changes need their own authority and validation boundary. Letting the worker weaken its own acceptance criteria defeats this talk's control model.
- **Does a second agent solve verification?** It adds another fallible judgment. Prefer direct evidence for checkable facts and evaluate the remaining judgments empirically.
- **What about approvals after a restart?** Persist the pending action and exact version, resume from that record, and check freshness again. Persistence alone does not guarantee external actions happened only once.


## Detailed implementation source map

These local paths pin the examined implementation to commit `9b5f988e`. The higher-level diagrams summarize behavior across functions for teaching.

| Added topic | Source | What the source establishes |
| --- | --- | --- |
| State and ordered routes | `packages/core/src/loop/public-dev-loop-routing.mjs` | Canonical state vocabulary and route decisions, including explicit current-head approval evidence |
| Invalid state | `packages/core/src/loop/conductor-routing.mjs` | Missing/malformed targets or family-local state fail to reconciliation |
| Job card | `packages/core/src/loop/handoff-envelope.mjs` | Envelope fields derived from resolver/settings; shape validation |
| Review join | `packages/core/src/loop/gate-fanin.mjs` and sanctioned fan-in CLI | Required-coverage checks plus artifact validation and severity consolidation |
| Review/fix composition | `skills/docs/gate-review-sub-loop-contract.md` | Review context, fan-in, judge dispositions, act list, repair and re-entry procedure |
| Wait checkpoint | `scripts/loop/outer-loop.mjs` | Persisted interpreted state and conductor routing; identity/revision checks for carried state |
| Action/version race | `scripts/github/merge-pr.mjs` | Evidence-head comparison and revision-pinned merge command |

A control graph gives a place to encode these rules. Correct wiring, tests, trustworthy inputs, and the actual action boundary make the rules effective.
