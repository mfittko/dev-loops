# Finding the flow

*Loops, graphs, and more reliable AI agents*

Audience: company-wide; no programming knowledge assumed. Timing: approximately 20 minutes for slides 1–15, with slide 16 available for questions. [Open the deck](finding-the-flow.html). Use arrow keys, Page Up/Down, or Space; Home/End jumps. Links keep normal keyboard behavior. The HTML opens offline and uses no external assets. Browser print offers a landscape PDF; the HTML is the primary deliverable.

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

## 3. The arrows are rules — 1:15

Walk across the diagram. A node is a step that does work. An edge is an allowed transition between steps. A guard is a condition that must hold before that transition can happen.

State is the record used to make the decision: the current draft, its version, the facts retrieved, the check result, and who has approved it. That record should survive the current chat session when the process needs to resume later.

The backward arrow is essential. “Check failed” routes to revision, then a new check. It does not allow the agent to argue its way past the check. The controller can require that route even when the agent would prefer to declare completion.

Sources: [W3C SCXML](https://www.w3.org/TR/scxml/) specifies transition conditions; [LangGraph Graph API](https://docs.langchain.com/oss/python/langgraph/graph-api) describes state, nodes, and edges. The displayed three-step graph is our teaching example.

## 4. Old process ideas. New kinds of workers. — 1:15

This borrows from long-established state machines and workflow systems. The new part is having probabilistic model work inside a process we want to control.

There is actual material using the phrase “graph engineering”: a July 2026 LangChain practitioner article and an August 2026 survey preprint. Their scope is broader than this talk. It includes dynamic graphs, agent coordination, and evolving task structures. We are selecting one useful part: defined workflow boundaries, recovery, and evidence.

This is not a knowledge-graph or GraphRAG talk. Those structures organize information and relationships for retrieval. Here the graph organizes what work may happen next. Neither a framework nor multiple agents is required; ordinary code can implement a small state machine.

Sources: [3 Years of Graph Engineering with LangGraph](https://www.langchain.com/blog/3-years-of-graph-engineering-with-langgraph), 22 July 2026; [Feng et al.](https://arxiv.org/abs/2608.21156), recent preprint. Treat these as emerging terminology and practitioner framing, not a settled standard or comparative proof.

## 5. Let it write. Make it earn the send. — 1:45

This is an illustrative customer-service process, not a deployed company policy. The customer asks about an order. The agent receives the order facts and drafts a reply. Validation checks the fields we can check against the system of record, such as the order identifier and recipient. A person approves the exact draft before it is sent.

Suppose the agent used an old delivery date. Validation rejects the draft and returns the mismatched field. The workflow sends the work back for repair, then runs validation again. If the order system is unavailable, the workflow cannot establish that the draft matches the order. It waits or escalates; it does not send on the assumption that everything is probably fine.

The important implementation choice is below the drawing: the drafting agent has no direct send permission. A separate action boundary checks that the required evidence and approval exist for that version. If the agent has an unrestricted alternate send tool, a line on a slide is not a guardrail.

Validation does not prove every sentence is true. Structured field checks cover specific facts. Subjective tone, implications, and unusual requests may need a person or a fallible model-based evaluator.

## 6. No evidence. No permission to advance. — 1:15

Explain “fail closed” in ordinary terms: if we cannot establish permission, we do not perform the protected action. There are three outcomes, not two: pass, fail, and unknown/error.

The difference matters because real checks crash, external services time out, and records disappear. Those failures must not fall through a default “continue” branch. “The check crashed” is not “the check passed.”

Closed does not mean permanently stuck. The next permitted action may be to recover the evidence, retry a temporary read failure, or ask a person. What stays closed is the transition that requires the missing proof.

Source: [OWASP Fail Securely](https://community.owasp.org/Fail_securely) is a security principle about error paths and permission. Applying the same idea to quality gates is our design analogy; it is not an OWASP certification of agent correctness.

## 7. “Try again” needs a reason — 1:45

There are different failure types, and each deserves a different arrow.

A temporary outage may justify waiting and retrying the same call, with a limit on attempts or elapsed time. A bad draft needs changed work informed by feedback. Missing information may require a person. If the process exhausts its budget, it stops and hands over.

The subtle case is a timeout after sending. The sender may have succeeded even though the caller never received the confirmation. Repeating the action blindly could send the message twice. Reconcile with the external system, or use an operation identifier that makes repeating the request safe. Engineers call that property idempotency: retrying the same intended action does not create another effect.

The counter and stop route are part of the workflow, not something the model can reset by starting a new conversation. Avoid implying that a generic retry loop alone improves reasoning. Useful feedback and observable progress matter.

Sources: [AWS retry limits](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_mitigate_interaction_failure_limit_retries.html) and [Making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/). Recovery taxonomy is our synthesis. [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) also warns about replayed side effects on resume.

## 8. Approved which version? — 1:00

Read the two times aloud. The person approved version A. Two minutes later the agent changes the message. It may be a helpful change; it is still a different message. The approval must identify the version it covered.

This is also why a durable record is not automatically fresh evidence. Order facts may change, policies may change, and another worker may change the artifact. Re-read the relevant facts at the action boundary, and define what changes invalidate the earlier checks.

Version-bound approval is a design choice in this illustrative process. The following dev-loops example implements the same pattern for exact code revisions.

## 9. Prescribe the boundaries. Leave room inside them. — 1:15

We do not need to prescribe every thought. An investigation can be open-ended within a node: search several sources, compare hypotheses, choose useful tools, and draft an answer. The outside workflow still controls whether the work can advance, consume more budget, or perform a protected action.

The key distinction is where the decision comes from. If a model chooses every next edge, placing those edges in a graph has not made those choices deterministic. Code can enforce a restricted set of choices and mandatory checks; the model can exercise judgment within that set.

For very simple tasks, one model call and a validator may be enough. Extra graph structure should earn its place by making a real dependency, recovery path, or authority boundary explicit.

Sources: [Anthropic workflow/agent patterns](https://www.anthropic.com/engineering/building-effective-agents); [LangChain graph engineering](https://www.langchain.com/blog/3-years-of-graph-engineering-with-langgraph). The latter explicitly discusses full agents inside nodes and where rigid paths are a poor fit.

## 10. Apply it to AI development — 1:30

“dev-loops is where I've been applying these ideas to software development.”

For non-developers: a pull request is the shared record proposing a change to software. Automated tests, review findings, and approval attach to that record. Merge means accepting the proposed change into the main codebase; it does not necessarily mean deploying it to customers.

The diagram simplifies the lifecycle: define the work, implement it, pass a draft gate, work through review and repairs, then establish pre-approval evidence. There are returns from findings to repair. Waiting for an external check is a state too.

The outer router does not assume that the last chat message is current truth. It re-reads the artifact and derives the next route from current state. It is a state-based decision each cycle, not a requirement that every run blindly replay a fixed checklist from the start.

Source snapshot: [public routing contract](https://github.com/mfittko/dev-loops/blob/9b5f988e/skills/docs/public-dev-loop-contract.md) and [routing implementation](https://github.com/mfittko/dev-loops/blob/9b5f988e/packages/core/src/loop/public-dev-loop-routing.mjs). <!-- secret-scan:allow source links pinned to inspected repository commit -->

## 11. Yesterday's green doesn't clear today's change — 1:30

Give a short trace: tests fail on revision A. An agent repairs the code, producing revision B. The earlier evidence cannot establish that B is ready. The required pre-approval record must identify B.

The code uses a revision identifier called the head SHA. In `buildPreMergeGateCheck`, the pre-approval verdict must be visible, complete, clean, and match the current head. The draft gate also needs a visible clean verdict; do not say this function requires the draft verdict itself to match the current head.

The merge wrapper compares the head read for the action against the evidence head. It also pins the actual merge command to that revision, so a push between checking and merging cannot silently substitute a newer version.

The unreadable-review example has precise scope: when the size/risk approval rule needs review information, a reviews-read failure must not become “zero unresolved objections.” It blocks that required decision. The sanctioned merge wrapper also treats missing prerequisite evidence as failure. Do not extrapolate this into a claim that every action in every harness has complete mechanical coverage.

Sources: [detect-checkpoint-evidence.mjs, `buildPreMergeGateCheck`](https://github.com/mfittko/dev-loops/blob/9b5f988e/scripts/github/detect-checkpoint-evidence.mjs#L373); [merge-pr.mjs, head check and pinned merge](https://github.com/mfittko/dev-loops/blob/9b5f988e/scripts/github/merge-pr.mjs#L233). Code inspected at commit `9b5f988e`. <!-- secret-scan:allow source links pinned to inspected repository commit -->

## 12. “Checks passed” isn't “you may publish.” — 1:15

Evidence and authority answer different questions. Checks say which conditions were established. Human approval and authorization say whether the action may happen. The default lifecycle retains those decisions even when the technical evidence is clean.

The supported merge wrapper evaluates prerequisites and refuses when they fail. There are configured policy variations and explicitly scoped standing-authorization modes; this diagram is the default conceptual path, not a claim that every supported mode asks the same question in the same UI.

Be candid about enforcement scope. The project has deterministic runtime checks, procedural rules, and harness-specific hooks. Some hooks are optional; some shell operations remain convention-enforced. Bypasses require attention to actual credentials, tools, and repository protections. The case study demonstrates real checks at named boundaries, not an unbreakable cage.

Sources: [merge preconditions](https://github.com/mfittko/dev-loops/blob/9b5f988e/skills/docs/merge-preconditions.md), [merge evaluator](https://github.com/mfittko/dev-loops/blob/9b5f988e/packages/core/src/loop/merge-approval.mjs), [main-agent enforcement coverage](https://github.com/mfittko/dev-loops/blob/9b5f988e/skills/docs/main-agent-contract.md). <!-- secret-scan:allow source links pinned to inspected repository commit -->

## 13. Predictable rules. Fallible work. — 1:00

State the boundary clearly. Under the same rules, the same validated inputs can lead to the same permitted transition. That does not mean identical prose or tool responses, and it does not prove the output is correct.

A check can be incomplete. A model-based reviewer can make the same mistake as the author. A workflow can encode the wrong policy. The claim is more control over the process and better evidence about what happened, with output reliability still something to measure.

For questions about self-correction: [Huang et al., ICLR 2024](https://arxiv.org/abs/2310.01798) found limitations in intrinsic self-correction without external feedback for the models/tasks studied. It motivates real feedback; it is not a universal claim about current models.

## 14. Test the wrong turns — 1:30

Ask what would happen if the required check vanished. Then change the artifact after approval. Then simulate a timeout after an external action. The important test is whether the implementation takes the safe route when the happy path breaks.

Look at actual outcomes, not just the transcript saying “success.” Did the message send to the intended person, once, after the approved checks? Across repeated tasks, record success and failure, policy escapes, human handovers, time, and cost. Keep task difficulty and definitions stable when comparing workflow versions.

We have not presented a measured before/after reliability improvement for dev-loops. Its concrete mechanisms and regression checks support a process claim; an improvement percentage would need an experiment.

Source: [Anthropic, Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), 9 January 2026. It distinguishes traces from environment outcomes and repeated-trial evaluation.

## 15. Make the next step depend on evidence — 1:00

“Pick a process you already know. Draw the steps. At each arrow, ask what must be true before we move on. Then draw what happens when it isn't.”

Start with one meaningful boundary, not a platform project. Decide how to recover, when to stop, and who can authorize the final action. Let the agent remain useful inside that process.

End on the user's line: “Let reliable results depend less on the agent following oh-so-sophisticated prompts.” Pause for questions.

## 16. Further down the graph — appendix

Leave this on screen during questions. The [research companion](finding-the-flow-research.md) maps each external source to supported claims, presentation use, and caveats. All links are primary material; the survey is explicitly a recent preprint. The dev-loops links pin the inspected source revision rather than promising that a moving main branch always says the same thing.

## Questions to expect

- **Isn't this just workflow automation?** Much of the control structure is. The interesting engineering work is deciding where probabilistic judgment belongs, what evidence to demand, and how recovery behaves when the work or the environment changes.
- **Do we need LangGraph?** No. It provides useful graph and persistence primitives; a small process can use ordinary code. Framework selection depends on actual needs.
- **Does fail closed mean more interruptions?** It can. Unknown evidence stops protected advancement. Measure whether those stops catch important failures or reveal checks that need a better recovery path.
- **Can the agent change the workflow?** It can propose a change, but policy changes need their own authority and validation boundary. Letting the worker weaken its own acceptance criteria defeats this talk's control model.
- **Does a second agent solve verification?** It adds another judgment, not certainty. Prefer direct evidence for checkable facts and evaluate the remaining judgments empirically.
- **What about approvals after a restart?** Persist the pending action and exact version, resume from that record, and check freshness again. Persistence alone does not guarantee external actions happened only once.
