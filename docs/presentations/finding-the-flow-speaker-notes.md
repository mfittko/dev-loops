# Finding the flow

*Loops, graphs, and more reliable AI agents*

Audience: company-wide; no programming knowledge assumed. Timing: 48 minutes of explanation, a 2-minute audience exercise, and 10 minutes for questions: 60 minutes total. Slides 1–34 take 50 minutes including the exercise; slide 35 stays up during questions. [Open the deck](finding-the-flow.html). Use arrow keys, Page Up/Down, or Space; Home/End jumps. Links keep normal keyboard behavior. The HTML opens offline and uses no external assets. Browser print offers a landscape PDF; the HTML is the primary deliverable.

## Running order

| Section | Slides | Time |
| --- | --- | --- |
| Foundations: steps, state, guards | 1–6 | 6:45 |
| Customer graph: four traces and recovery | 7–13 | 11:00 |
| Bounded freedom and parallel checks | 14–16 | 5:00 |
| dev-loops: routing, job cards and nested reviews | 17–22 | 9:30 |
| Actual UI sub-loop used for this deck | 23–25 | 4:30 |
| dev-loops: evidence, waits and authority | 26–29 | 7:00 |
| Audience exercise and answer | 30–31 | 3:00 |
| Limits, evaluation, close | 32–34 | 3:15 |
| Questions, with sources on screen | 35 | 10:00 |

Walk the highlighted arrows rather than reading every label. The customer diagrams show the same process over four states. Their values and retry budgets are illustrative, not production logs. The public router's five fields are a useful vocabulary; actual decisions also depend on validated evidence and settings.

## Pitch

AI agents improvise. Sometimes they skip a step or declare success too soon. A predefined workflow gives them strict guardrails: checks they must pass, steps they must redo when something goes wrong, and boundaries that fail closed when they can't safely continue. This talk explores how loops and graphs make those rules enforceable, so reliable results depend less on the agent following oh-so-sophisticated prompts.

## 1. Finding the flow — 0:45

“I want to talk about the part of AI work that happens between asking for something and believing it's done.”

For this talk, an agent is an AI system that can use tools and take actions across several steps. It might look up an order, draft a response, run a check, and decide what to do next. We are interested in the process around those actions.

The question is not whether we can get a good result once. It is what has to happen before the system is allowed to treat the work as complete. The title is about finding that process and making it explicit.

## 2. “Done.” According to whom? — 1:00

Use a hypothetical example: “You ask an agent to prepare a customer reply and check the order details first. It produces a very plausible answer. Did it actually check?”

A detailed prompt can say that the check is mandatory. If the same agent also decides whether it has obeyed the prompt, we are still depending on its interpretation. This is an architectural distinction: instructions tell the model what to do; executable checks and permissions decide whether an action is allowed.

Do not imply that prompts are useless. They remain important for the quality of work within a step. The point is that mandatory process rules need another home too.

## 3. The arrows are rules — 1:30

Walk across the diagram. A node is a step that does work. An edge is an allowed transition between steps. A guard is a condition that must hold before that transition can happen.

State is the record used to make the decision: the current draft, its version, the facts retrieved, the check result, and who has approved it. That record should survive the current chat session when the process needs to resume later.

The backward arrow is essential. “Check failed” routes to revision, then a new check. It does not allow the agent to argue its way past the check. The controller can require that route even when the agent would prefer to declare completion.

Sources: [W3C SCXML](https://www.w3.org/TR/scxml/) specifies transition conditions; [LangGraph Graph API](https://docs.langchain.com/oss/python/langgraph/graph-api) describes state, nodes, and edges. The displayed three-step graph is our teaching example.


## 4. The graph remembers facts — 1:00

Point to the difference between the work record and the control record. The draft and the retrieved order data describe what is being worked on. Validation, attempt count, and approval describe what the system is permitted to do with it.

The illustrative record says version B failed validation and has no approval. That makes “send” unavailable even if B looks polished. The next step can be computed from the check outcome and the remaining repair budget. Explain that these values should be recorded by the responsible tool or controller, not accepted merely because the drafting model wrote them in its answer.

State persists only the facts needed for this process; it need not preserve every thought or the full chat transcript. Keep the record small and explicit.

## 5. A transition is a small contract — 1:30

Zoom into just one arrow: approve → send. Its contract identifies the exact work and recipient, the evidence required, and the authority needed. The sending service checks that contract when called.

After executing, it records what actually happened. There is a meaningful distinction between “send attempted,” “delivery confirmed,” and “delivery status unknown.” If a network failure leaves the outcome unknown, the next step is reconciliation, not blindly repeating the send.

Ask rhetorically: “If I draw this arrow on a whiteboard but leave the agent another unrestricted send tool, what did I enforce?” The answer is nothing at that alternate action boundary. This is why the graph and the tool permissions have to agree.

This is an illustrative action contract. The source ideas are guarded state transitions, fail-secure action boundaries, and safe retry semantics, covered by the W3C, OWASP, and AWS references in the research companion.

## 6. Old process ideas. New kinds of workers. — 1:00

This borrows from long-established state machines and workflow systems. The new part is having probabilistic model work inside a process we want to control.

There is actual material using the phrase “graph engineering”: a July 2026 LangChain practitioner article and an August 2026 survey preprint. Their scope is broader than this talk. It includes dynamic graphs, agent coordination, and evolving task structures. We are selecting one useful part: defined workflow boundaries, recovery, and evidence.

This is not a knowledge-graph or GraphRAG talk. Those structures organize information and relationships for retrieval. Here the graph organizes what work may happen next. Neither a framework nor multiple agents is required; ordinary code can implement a small state machine.

Sources: [3 Years of Graph Engineering with LangGraph](https://www.langchain.com/blog/3-years-of-graph-engineering-with-langgraph), 22 July 2026; [Feng et al.](https://arxiv.org/abs/2608.21156), recent preprint. Treat these as emerging terminology and practitioner framing, not a settled standard or comparative proof.

## 7. Let it write. Make it earn the send. — 1:00

This is an illustrative customer-service process, not a deployed company policy. The customer asks about an order. The agent receives the order facts and drafts a reply. Validation checks the fields we can check against the system of record, such as the order identifier and recipient. A person approves the exact draft before it is sent.

Suppose the agent used an old delivery date. Validation rejects the draft and returns the mismatched field. The workflow sends the work back for repair, then runs validation again. If the order system is unavailable, the workflow cannot establish that the draft matches the order. It waits or escalates; it does not send on the assumption that everything is probably fine.

The important implementation choice is below the drawing: the drafting agent has no direct send permission. A separate action boundary checks that the required evidence and approval exist for that version. If the agent has an unrestricted alternate send tool, a line on a slide is not a guardrail.

Validation does not prove every sentence is true. Structured field checks cover specific facts. Subjective tone, implications, and unusual requests may need a person or a fallible model-based evaluator.


## 8. Follow the happy path — 1:30

Introduce the diagram once. The top row is draft → validate → human approval → guarded send. Lower branches represent repair and recovering unavailable facts. Cyan nodes and edges show the current trace; the muted routes remain available when their conditions are met.

Read the state snapshot: draft A, validation passed for A, approval names A. The send guard now has the facts it needs. The agent did useful work, but it did not decide on its own that approval could be skipped.

Walk one arrow at a time. The draft-ready event permits validation; the passing result permits asking for approval; the person's recorded decision permits the guarded send. These are different facts from different producers.

Do not call this a guarantee of a perfect reply. It demonstrates that the stipulated checks and authority precede the action. The system still needs good checks for the facts and risks that matter.

## 9. A failed check sends it back — 2:00

Keep the same graph on screen so the audience can see what changed: only the observed state and the highlighted route.

The validator compares the order date in draft A with the order record and returns a specific mismatch. That failed result makes the route to approval unavailable. The controller dispatches repair with the mismatch as feedback.

The agent creates B. B is new work; it has no passing validation merely because A was checked. Follow the return arrow to a fresh validation. Count the attempt in the controller's state. The “1 of 3” budget introduced earlier is illustrative; a real budget depends on risk, time, and cost.

Emphasize the distinction from repeatedly prompting “try harder.” The feedback names the defect, the work changes, the check runs again, and the loop has an exit.

## 10. Unknown takes another arrow — 2:00

The order service is unavailable, so validation cannot establish whether the date is right. That is unknown, not a failed factual comparison. Sending is still unavailable, but the appropriate recovery action differs.

Follow the unknown branch to recover facts. If the service returns within the remaining budget, follow the facts-restored arrow back to validation. If attempts or elapsed time run out, follow the handover branch. A human can resolve missing information or choose another authorized path; the workflow does not silently lower its requirements.

Distinguish a known external wait from unknown process state. We may know a check is running and safely wait for it. If we cannot establish which work is active or whether an action occurred, we first reconcile those facts.

Keep recovery bounded and avoid inventing a fixed retry count as a universal recommendation. AWS's retry guidance supports budgets, backoff, and care around overloaded services.

## 11. A changed draft loses its clearance — 1:00

A was checked and approved. The agent improves the wording and saves B. The work might be better, but the stored approval still names A.

The guard compares the current work version to the approved version. It finds a mismatch and sends B through validation and approval. This is invalidation: earlier evidence is retained as history, but it no longer permits advancement of changed work.

This diagram isolates the edit boundary instead of drawing every route at once. A production process can sometimes reuse evidence for demonstrably unaffected parts, but that needs an explicit policy and coverage model. Our illustration conservatively rechecks the whole draft.

## 12. No evidence. No permission to advance. — 1:30

Explain “fail closed” in ordinary terms: if we cannot establish permission, we do not perform the protected action. There are three outcomes, not two: pass, fail, and unknown/error.

The difference matters because real checks crash, external services time out, and records disappear. Those failures must not fall through a default “continue” branch. “The check crashed” is not “the check passed.”

Closed does not mean permanently stuck. The next permitted action may be to recover the evidence, retry a temporary read failure, or ask a person. What stays closed is the transition that requires the missing proof.

Source: [OWASP Fail Securely](https://community.owasp.org/Fail_securely) is a security principle about error paths and permission. Applying the same idea to quality gates is our design analogy; it is not an OWASP certification of agent correctness.

## 13. “Try again” needs a reason — 2:00

There are different failure types, and each deserves a different arrow.

A temporary outage may justify waiting and retrying the same call, with a limit on attempts or elapsed time. A bad draft needs changed work informed by feedback. Missing information may require a person. If the process exhausts its budget, it stops and hands over.

The subtle case is a timeout after sending. The sender may have succeeded even though the caller never received the confirmation. Repeating the action blindly could send the message twice. Reconcile with the external system, or use an operation identifier that makes repeating the request safe. Engineers call that property idempotency: retrying the same intended action does not create another effect.

The counter and stop route are part of the workflow, not something the model can reset by starting a new conversation. Avoid implying that a generic retry loop alone improves reasoning. Useful feedback and observable progress matter.

Sources: [AWS retry limits](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_mitigate_interaction_failure_limit_retries.html) and [Making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/). Recovery taxonomy is our synthesis. [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) also warns about replayed side effects on resume.


## 14. Prescribe the boundaries. Leave room inside them. — 1:30

We do not need to prescribe every thought. An investigation can be open-ended within a node: search several sources, compare hypotheses, choose useful tools, and draft an answer. The outside workflow still controls whether the work can advance, consume more budget, or perform a protected action.

The key distinction is where the decision comes from. If a model chooses every next edge, placing those edges in a graph has not made those choices deterministic. Code can enforce a restricted set of choices and mandatory checks; the model can exercise judgment within that set.

For very simple tasks, one model call and a validator may be enough. Extra graph structure should earn its place by making a real dependency, recovery path, or authority boundary explicit.

Sources: [Anthropic workflow/agent patterns](https://www.anthropic.com/engineering/building-effective-agents); [LangChain graph engineering](https://www.langchain.com/blog/3-years-of-graph-engineering-with-langgraph). The latter explicitly discusses full agents inside nodes and where rigid paths are a poor fit.


## 15. Parallel work still needs a join — 2:00

Introduce the second graph shape. Three independent checks can inspect the same version at the same time. In this example they cover facts, policy, and destination. “Fan out” starts those branches. “Fan in” gathers their outcomes.

Why the same evidence bundle? If each check sees a different draft or a different order record, their results may not describe one coherent candidate. A bundle gives the branches a common starting point. It does not make their judgments infallible.

A join is an actual decision boundary. It needs a declared list of required outcomes, version identity, and valid result formats. It can then evaluate the results according to the workflow's policy. A model-based policy check remains a model judgment even when its result format is valid.

Parallelism is optional. Use it when the checks are genuinely independent and the saved wait outweighs the coordination cost.

## 16. Two passes and a missing check — 1:30

Ask the audience to decide before reading the answer: “Two passed. One never returned. Are we done?”

No: the recipient check was required and its outcome is absent. The workflow cannot treat silence as approval. It can recover that missing result, rerun a safe check within its budget, or stop. It cannot average the three outcomes.

Keep this precise: all required checks must have accountable outcomes, but not every observation must be blocking. A policy can classify some findings as advisory. Completeness and severity are separate questions. This distinction becomes concrete in the dev-loops review round.

## 17. Apply it to AI development — 1:30

“dev-loops is where I've been applying these ideas to software development.”

For non-developers: a pull request is the shared record proposing a change to software. Automated tests, review findings, and approval attach to that record. Merge means accepting the proposed change into the main codebase; it does not necessarily mean deploying it to customers.

The diagram simplifies the lifecycle: define the work, implement it, pass a draft gate, work through review and repairs, then establish pre-approval evidence. There are returns from findings to repair. Waiting for an external check is a state too.

The outer router does not assume that the last chat message is current truth. It re-reads the artifact and derives the next route from current state. It is a state-based decision each cycle, not a requirement that every run blindly replay a fixed checklist from the start.

Source snapshot: [public routing contract](https://github.com/mfittko/dev-loops/blob/9b5f988e/skills/docs/public-dev-loop-contract.md) and [routing implementation](https://github.com/mfittko/dev-loops/blob/9b5f988e/packages/core/src/loop/public-dev-loop-routing.mjs). <!-- secret-scan:allow source links pinned to inspected repository commit -->


## 18. What does the router know? — 1:00

Translate the five fields. Target is the active work record. Ownership is lasting responsibility. Next actor is who should act now. Status describes the current condition. Authorization records whether the action is allowed.

Ownership and next actor can differ. Copilot may own implementation while a reviewer needs to act next. That distinction avoids treating “owned by Copilot” as “Copilot should always do the next thing.”

The example pull-request number is invented for teaching. Real routing also consumes evidence and policy settings; do not claim this table alone is the entire input. The important principle is using an explicit, validated state instead of guessing from conversational context.

Source: public routing contract and `packages/core/src/loop/public-dev-loop-routing.mjs` at the inspected revision.

## 19. One state, one next action — 1:00

Read three rows: blocked or unauthorized stops; a known external wait routes to wait/watch; reviewer-next routes to the review/fix strategy. The order of these rules matters when several facts could appear relevant.

The “ready” row catches a common shortcut. In dev-loops, a readiness label is not a substitute for explicit, visible, clean pre-approval evidence for the current revision. Green automated checks and resolved discussion threads do not replace that gate record.

If target identity or family-local state is malformed or missing, reconciliation happens before routing. That is different from healthy waiting: we cannot select a justified route until we know what state we are in.

Sources: `routeForState` in public-dev-loop-routing.mjs and `evaluateConductorRouting` in conductor-routing.mjs. The displayed cases are examples, not a complete executable reproduction of the router.

## 20. Give the worker a job card — 2:00

Use the job-card analogy: a worker needs to know which work item is active, what to read, what action to take, and what evidence to return. They also need the stopping rules.

dev-loops derives that handoff envelope from resolved state and settings. The named fields include `nextAction`, `requiredReads`, `stopRules`, and acceptance criteria. This reduces the amount of workflow the worker must reconstruct from a long conversation.

A fresh session can receive the contract and continue the bounded job. Malformed or contradictory handoff structures are rejected by validation. Volatile evidence still needs refreshing near the action.

The card is not itself a permission system. An agent can misunderstand prose in it. Protected actions need their runtime guards too. This is the relationship between good instructions and mechanical enforcement, rather than a claim that structured text becomes unbreakable.

Source: `buildDevLoopHandoffEnvelope` and its validator in `packages/core/src/loop/handoff-envelope.mjs`.

## 21. A loop can contain another loop — 2:00

Trace the outside rectangle: observe current facts, resolve a route, perform a bounded action, refresh. On the next cycle, the router evaluates the new state again.

Now point inside the action. “Handle the review” can contain its own review-and-repair loop. It has a narrower goal and its own budget. A successful inner step returns evidence to the outer loop; it does not automatically grant permission for every later action.

This is a conceptual composition diagram, not a claim that every diagram node is one function. The repository contains multiple state machines and coordination layers. `outer-loop.mjs` interprets Copilot and reviewer state, calls conductor routing, and persists the checkpoint. The public router and lifecycle guards supply additional boundaries.

The value of nesting is scale: the outer process remains understandable while a complex job uses its own bounded mechanics.

## 22. A review round has an output contract — 2:00

Zoom into the inner loop. A current evidence bundle carries the scope and revision to the required review lenses. Lenses may be grouped into dispatch units; do not equate every lens with a separate agent.

The join is layered. First, coverage checks establish whether the required review outcomes are present. Then result artifacts and revision identity are validated. Finally, findings are consolidated using the configured blocking threshold. Missing or malformed required evidence blocks; a clean outcome may contain nonblocking observations.

This implementation detail matters: `consolidateFanin([])` alone can return clean. The separate expected-coverage checks in the CLI and coverage functions establish whether an empty or partial set is permissible. Reliability comes from the composed contract, not the name of a helper.

After required evidence is complete, the mandatory judge phase produces scope/relevance dispositions and the deterministic bridge derives the fixer's act list. Do not draw consolidation's clean result as a shortcut past that phase. Only findings classified for action go to repair; other dispositions can defer or reject a finding. A repair creates a new revision; refreshed evidence and the required reviews/gates follow. If budget is exhausted, the workflow stops or escalates rather than pretending the round converged.

Sources: `packages/core/src/loop/gate-fanin.mjs`, `checkFanoutAngleCoverage`, `checkResolvedAngleEvidence`, the sanctioned fan-in CLI, and the gate-review sub-loop contract. The diagram summarizes the intended composition; these checks do not make reviewer judgments infallible.


## 23. We just used a UI sub-loop — 2:00

This example is this presentation during preparation. The implementing agent authored the HTML and ran the shared browser suite. The parent agent inspected screenshots and returned visual findings. No separately dispatched designer or visual-reviewer agent is being claimed.

The browser renders the current HTML. Automated checks measure viewport fit, accessibility, runtime errors, and keyboard navigation. Visual review inspects the actual diagram, including the meaning of the highlighted paths. Findings return to the author, who repairs the relevant presentation content and produces a fresh render.

The initial 33-slide expanded draft passed all six browser tests. Visual review still found hidden arrow labels, an incorrect active branch, and a return path crossing a nested-loop callout. That is direct evidence from preparing this deck, not a hypothetical limitation.

Explain the sub-loop boundary: the outer task remains “prepare the talk.” The narrower UI job is “make the current slides readable and diagrammatically correct under the stated checks.” The author repeats that job until the results are ready to return to the outer task.

## 24. The tests passed. The graph still told the wrong story. — 1:30

Show the embedded earlier screenshot. The state snapshot says two waits remain, but the first diagram highlighted the exhausted-budget handover too. That incorrectly suggests the current run is already taking the handover branch.

The reviewer also found “draft ready” and “approved” labels partly hidden by adjacent nodes. We shortened them to fit the edge gaps. In the outer-loop drawing, the return line passed behind the inner-loop box; moving the box and using a dashed containment connection separated return flow from nesting.

These are real review findings, corrected in the later draft. The screenshot is explicitly the earlier version, retained as evidence of the preparation process. It is not the current recommended graph.

The successful automated tests and the visual findings answer different questions. Passing layout checks establishes geometric fit under those assertions. It does not establish that the story told by a graph is correct.

## 25. Exit on evidence for the current render — 1:00

Turn the observed collaboration into a reusable workflow contract. Every edit requires a fresh render. Required automated and visual results must be present. Actionable findings return to the author, while the outer process waits for the sub-loop result and then refreshes its state.

The retry-budget row is a proposed control rule, not a configured automatic cap in this preparation session. To enforce it, a real controller would need to count attempts and block another round at the limit until an authorized decision.

Likewise, the actual visual review here was an agent inspecting screenshots in conversation. Do not claim a runtime validator mechanically enforced its final approval. The diagram shows what was done; this slide distinguishes the additional control rules one could encode.

“Clean” means no remaining actionable findings within the selected checks and review scope. It does not mean objective proof of good taste or that no audience member will misunderstand a slide.


## 26. Yesterday's green doesn't clear today's change — 2:00

Give a short trace: tests fail on revision A. An agent repairs the code, producing revision B. The earlier evidence cannot establish that B is ready. The required pre-approval record must identify B.

The code uses a revision identifier called the head SHA. In `buildPreMergeGateCheck`, the pre-approval verdict must be visible, complete, clean, and match the current head. The draft gate also needs a visible clean verdict; do not say this function requires the draft verdict itself to match the current head.

The merge wrapper compares the head read for the action against the evidence head. It also pins the actual merge command to that revision, so a push between checking and merging cannot silently substitute a newer version.

The unreadable-review example has precise scope: when the size/risk approval rule needs review information, a reviews-read failure must not become “zero unresolved objections.” It blocks that required decision. The sanctioned merge wrapper also treats missing prerequisite evidence as failure. Do not extrapolate this into a claim that every action in every harness has complete mechanical coverage.

Sources: [detect-checkpoint-evidence.mjs, `buildPreMergeGateCheck`](https://github.com/mfittko/dev-loops/blob/9b5f988e/scripts/github/detect-checkpoint-evidence.mjs#L373); [merge-pr.mjs, head check and pinned merge](https://github.com/mfittko/dev-loops/blob/9b5f988e/scripts/github/merge-pr.mjs#L233). Code inspected at commit `9b5f988e`. <!-- secret-scan:allow source links pinned to inspected repository commit -->


## 27. Waiting survives the conversation — 1:30

An external test or review may take longer than a chat session. A checkpoint records enough identity and interpreted state to reattach: which repository, which work record, which revision, and what wait was in progress.

On resumption, use that checkpoint to find the work, then refresh authoritative facts. An old checkpoint saying “waiting for review” is not a reason to ignore a review that has since arrived. A newer revision can invalidate the old conclusion.

The outer-loop code preserves carried wait-cycle state only with matching identity and revision conditions. It distinguishes continuing a known wait from stopping on inconsistent state. Our diagram explains the intention; actual waiting mechanics and enforcement vary by layer and harness.

Sources: `scripts/loop/outer-loop.mjs`, conductor-routing.mjs, and the public startup/resume contract.

## 28. “Checks passed” isn't “you may publish.” — 1:30

Evidence and authority answer different questions. Checks say which conditions were established. Human approval and authorization say whether the action may happen. The default lifecycle retains those decisions even when the technical evidence is clean.

The supported merge wrapper evaluates prerequisites and refuses when they fail. There are configured policy variations and explicitly scoped standing-authorization modes; this diagram is the default conceptual path, not a claim that every supported mode asks the same question in the same UI.

Be candid about enforcement scope. The project has deterministic runtime checks, procedural rules, and harness-specific hooks. Some hooks are optional; some shell operations remain convention-enforced. Bypasses require attention to actual credentials, tools, and repository protections. The case study demonstrates real checks at named boundaries, not an unbreakable cage.

Sources: [merge preconditions](https://github.com/mfittko/dev-loops/blob/9b5f988e/skills/docs/merge-preconditions.md), [merge evaluator](https://github.com/mfittko/dev-loops/blob/9b5f988e/packages/core/src/loop/merge-approval.mjs), [main-agent enforcement coverage](https://github.com/mfittko/dev-loops/blob/9b5f988e/skills/docs/main-agent-contract.md). <!-- secret-scan:allow source links pinned to inspected repository commit -->


## 29. The merge checks the actual version — 2:00

This table shows two possible branches, not four consecutive events.

First branch: the wrapper reads candidate A, but the evidence read returns B because a new push landed. The mismatch fails the precondition, so the process must read and assess the current revision again.

Second branch: candidate and evidence both match A. The wrapper pins the merge command to A with `--match-head-commit`. If B appears before the merge runs, that command refuses the unchecked replacement.

This closes a timing gap between observing permission and executing the action. It still relies on the behavior of the underlying merge API and configured repository protections. Keep the claim local: these are concrete checks in the sanctioned wrapper, not proof that every possible tool or credential is incapable of bypass.

Source: `scripts/github/merge-pr.mjs`, head mismatch comparison and version-pinned merge invocation.

## 30. Which arrow is allowed? — 2:00

Give people 60 seconds with a neighbor, then take two or three answers. Ask them to name the missing fact, not just say “stop.”

A: the draft is ready, but the check timed out. B: a person approved A, while the current draft is B. C: all checks pass, but publishing has not been authorized.

Leave this slide up during discussion. The next slide is the answer reveal; no interactive simulator or network connection is required. This two-minute block is included in the 50-minute content slot.

## 31. A pause can be the correct result — 1:00

A needs evidence recovery within a budget. B needs validation and approval for the current version. C needs an authorized decision.

Point out that all three can be productive next steps even though none publishes the work immediately. The workflow preserves the distinction between doing more work, learning what happened, and obtaining authority.

If someone proposes “ask another AI,” ask what evidence or permission that answer could actually establish. A second opinion might help quality; it cannot create a person's authorization.

## 32. Predictable rules. Fallible work. — 1:00

State the boundary clearly. Under the same rules, the same validated inputs can lead to the same permitted transition. That does not mean identical prose or tool responses, and it does not prove the output is correct.

A check can be incomplete. A model-based reviewer can make the same mistake as the author. A workflow can encode the wrong policy. The claim is more control over the process and better evidence about what happened, with output reliability still something to measure.

For questions about self-correction: [Huang et al., ICLR 2024](https://arxiv.org/abs/2310.01798) found limitations in intrinsic self-correction without external feedback for the models/tasks studied. It motivates real feedback; it is not a universal claim about current models.

## 33. Test the wrong turns — 1:30

Ask what would happen if the required check vanished. Then change the artifact after approval. Then simulate a timeout after an external action. The important test is whether the implementation takes the safe route when the happy path breaks.

Look at actual outcomes, not just the transcript saying “success.” Did the message send to the intended person, once, after the approved checks? Across repeated tasks, record success and failure, policy escapes, human handovers, time, and cost. Keep task difficulty and definitions stable when comparing workflow versions.

We have not presented a measured before/after reliability improvement for dev-loops. Its concrete mechanisms and regression checks support a process claim; an improvement percentage would need an experiment.

Source: [Anthropic, Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), 9 January 2026. It distinguishes traces from environment outcomes and repeated-trial evaluation.

## 34. Make the next step depend on evidence — 0:45

“Pick a process you already know. Draw the steps. At each arrow, ask what must be true before we move on. Then draw what happens when it isn't.”

Start with one meaningful boundary, not a platform project. Decide how to recover, when to stop, and who can authorize the final action. Let the agent remain useful inside that process.

End on the user's line: “Let reliable results depend less on the agent following oh-so-sophisticated prompts.” Pause for questions.

## 35. Further down the graph — appendix / questions

Leave this on screen during questions. The [research companion](finding-the-flow-research.md) maps each external source to supported claims, presentation use, and caveats. All links are primary material; the survey is explicitly a recent preprint. The dev-loops links pin the inspected source revision rather than promising that a moving main branch always says the same thing.

## Questions to expect

- **Isn't this just workflow automation?** Much of the control structure is. The interesting engineering work is deciding where probabilistic judgment belongs, what evidence to demand, and how recovery behaves when the work or the environment changes.
- **Do we need LangGraph?** No. It provides useful graph and persistence primitives; a small process can use ordinary code. Framework selection depends on actual needs.
- **Does fail closed mean more interruptions?** It can. Unknown evidence stops protected advancement. Measure whether those stops catch important failures or reveal checks that need a better recovery path.
- **Can the agent change the workflow?** It can propose a change, but policy changes need their own authority and validation boundary. Letting the worker weaken its own acceptance criteria defeats this talk's control model.
- **Does a second agent solve verification?** It adds another judgment, not certainty. Prefer direct evidence for checkable facts and evaluate the remaining judgments empirically.
- **What about approvals after a restart?** Persist the pending action and exact version, resume from that record, and check freshness again. Persistence alone does not guarantee external actions happened only once.


## Detailed implementation source map

These local paths pin the examined implementation to commit `9b5f988e`. The higher-level diagrams are teaching summaries, not literal one-node-per-function renderings.

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
