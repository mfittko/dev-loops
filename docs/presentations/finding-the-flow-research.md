# Finding the flow — primary-source research

Research date: 2026-09-15. Purpose: a company-wide presentation about predictable AI-agent processes, with dev-loops as one worked example. All sources below are primary documentation, standards, or original research. These notes distinguish sourced claims from proposed presentation framing.

## The defensible thesis

Use deterministic code to decide which transitions and actions are permitted, while models do work inside those boundaries. Verify observable results, route recoverable failures back with useful feedback, and stop or escalate when required evidence is unavailable. This is a design synthesis from the sources below, not a claim that graphs guarantee correct answers.

“Graph engineering” is an emerging umbrella term, used explicitly by LangChain and a recent survey (sources 10–11). This talk selects its workflow-control aspect: designing states, steps, transitions, guards, recovery paths, and evidence. Established foundations include state machines and workflow orchestration. Do not present it as a standardized new discipline or equate the whole field with a fixed flowchart. It is distinct from merely supplying an agent a knowledge graph/GraphRAG.

## 1. Workflows versus agents; checks and feedback loops

Source: [Anthropic, Building effective agents](https://www.anthropic.com/engineering/building-effective-agents), originally 2024-12-19; current page notes tooling has evolved.

Supported claims: workflows orchestrate models and tools through predefined code paths; agents let models dynamically direct their process. The article describes prompt chaining with programmatic gates, routing, and evaluator–optimizer loops. It recommends simple patterns, measurable evaluation criteria, feedback from actual tool results, and stopping conditions such as maximum iterations.

Presentation use: distinguish choosing useful work from deciding whether the process may advance. A workflow can contain an agent inside a step. The distinction is about control, not whether an LLM is present.

Caveat: an evaluator implemented with an LLM remains fallible; this pattern alone is not a strict guarantee. Complexity also costs latency and money. A graph is unnecessary if a single call meets the task’s needs.

## 2. What a graph actually contains

Source: [LangGraph, Graph API overview](https://docs.langchain.com/oss/python/langgraph/graph-api).

Supported claims: graph state carries information; nodes perform work and update it; edges define where execution goes next. Conditional edges use a routing function that receives current state. The documentation also covers node re-execution and idempotency.

Presentation use: draw “draft → check → approve,” then a failure arrow back to “revise.” Label nodes as work, arrows as permitted next steps, state as the recorded facts, and guards as conditions for taking an arrow.

Caveat: putting an agent in a graph does not automatically constrain every tool action inside a node. Nor are conditional edges automatically deterministic if they rely on model judgments. Permission checks must be enforced where actions execute. Explicit graph wiring can itself be wrong.

## 3. Pausing is a real state

Source: [LangGraph, Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts).

Supported claims: interrupts pause a graph and persist state using a checkpointer until external input resumes it. Production persistence needs a durable checkpointer and a stable thread identity. Interrupted nodes restart from their beginning on resumption, so side effects before an interrupt must be idempotent.

Presentation use: “waiting for a person” is an explicit, resumable state rather than a conversational suggestion. Approval must be recorded and applied to the pending action.

Caveat: persistence is not proof that a completed external action ran exactly once. Resuming work can repeat effects unless the implementation prevents duplicates.

## 4. The old engineering beneath the new agent

Source: [W3C, State Chart XML: State Machine Notation for Control Abstraction](https://www.w3.org/TR/scxml/), Recommendation 2015-09-01. Especially transition conditions and Appendix D semantics.

Supported claims: transitions can require both a matching event and a true condition. The state-machine semantics specify causal behavior and deterministic processing for a given event sequence, with qualifications for explicitly nondeterministic behavior and invoked external processors. The standard permits nonterminating macrosteps, so termination does not follow merely from using a state machine.

Presentation use: graphs are executable process maps built on longstanding engineering ideas. The novelty is placing probabilistic model work inside them.

Caveat: deterministic control means the same validated state and inputs yield the same permitted transition under the same rules. It does not mean identical prose, identical tool outcomes, or a guaranteed successful run.

## 5. Fail closed means missing proof cannot become permission

Source: [OWASP, Fail Securely](https://community.owasp.org/Fail_securely).

Supported claim: when a security mechanism errors, its failure should follow the disallow path rather than accidentally permitting the operation. The source distinguishes allow, disallow, and exception outcomes.

Presentation use (explicit analogy): apply that principle to workflow advancement: pass permits the next action; fail routes to repair or rejection; unknown/error prevents advancement while evidence is recovered or a person intervenes. “The check crashed” is not “the check passed.”

Caveat: this source is about security controls. Applying it to quality gates is our design analogy, not a claim OWASP certifies agent output. A fail-closed check is only effective if the agent cannot bypass the controlled action boundary.

## 6. Retrying needs a budget

Source: [AWS Well-Architected, Control and limit retry calls](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_mitigate_interaction_failure_limit_retries.html).

Supported claims: transient failures may benefit from retries; retrying overload can worsen it. AWS recommends backoff, jitter, and a maximum retry count or elapsed-time limit.

Presentation use: distinguish a transient tool outage (retry the call), a rejected draft (revise with feedback), missing human information (pause), and exhausted attempts (stop/escalate). This taxonomy is our synthesis, not AWS terminology.

Caveat: repeating the same bad reasoning is not equivalent to retrying a temporary network error. A loop should have a progress signal and a stopping rule. “Keep trying until it works” is not a reliability policy.

## 7. Retry the work without duplicating its effects

Source: [Amazon Builders’ Library, Making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/), Malcolm Featonby.

Supported claims: a failed or timed-out request can leave the caller unsure whether the remote action completed. Idempotent APIs allow a request to be repeated without extra side effects. Caller-supplied request identifiers help services recognize repeated intent.

Presentation use: if a refund call times out, inspect or retry with the same operation identity; blindly issuing a new refund may pay twice. A recovery arrow must account for what already happened.

Caveat: graph checkpoints by themselves do not provide idempotency across external systems. Some actions require reconciliation or compensation instead of replay.

## 8. Asking again is not a correctness test

Source: [Huang et al., Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798), ICLR 2024; original submission 2023-10-03, revised 2024-03-14.

Supported claim: in the reasoning tasks/models studied, intrinsic self-correction without external feedback struggled and sometimes reduced performance.

Presentation use: a second “are you sure?” is weaker evidence than a check against the environment, a calculation, a test, or an accountable reviewer. Frame this as motivation to use useful feedback rather than blind repetition.

Caveat: this is evidence from particular earlier models, tasks, and prompting setups, not a proof that every current model cannot self-correct. Do not put the paper title on a slide as a universal present-day fact. Improved verification methods and models can change results.

## 9. Measure outcomes and repeated success

Source: [Anthropic, Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), 2026-01-09.

Supported claims: evaluations distinguish the execution trace from the final state of the environment. The article’s booking example checks whether a reservation exists rather than trusting the agent’s claim. Multiple trials expose output variability; graders can be code-based, model-based, or human. The article distinguishes success at least once across attempts from succeeding across repeated trials.

Presentation use: assess actual completion, forbidden transitions, recovery behavior, escalation, and cost/time over repeated runs. Include failure cases such as missing evidence and stale approval.

Caveat: passing gates establishes only what those gates test. Repeated success is an empirical reliability claim requiring measurements. Do not invent a dev-loops percentage or claim a graph improved accuracy without a comparison.

## 10. Directly topical practitioner material: graph engineering

Source: [Runkle and Chase, 3 Years of Graph Engineering with LangGraph](https://www.langchain.com/blog/3-years-of-graph-engineering-with-langgraph), 2026-07-22.

Supported claims: the framework authors explicitly use “graph engineering” for representing agent systems as graphs, blending fixed code paths with model and full-agent steps. They discuss cycles for recovery and revision, dynamic work allocation, and situations where rigid predetermined paths are a poor fit, such as open-ended research.

Presentation use: this is the closest direct match to the requested topic. A loop is already a simple graph; a whole agent can occupy one node in a larger controlled process. Known process structure can be encoded while leaving creative work flexible.

Caveat: this is a vendor practitioner perspective, not comparative experimental proof that graphs improve every task. Omit its download counts and unquantified speed/cost claims. Its flexibility argument also means “graph engineering” does not inherently mean predefined, strict, fail-closed controls; those are deliberate choices for this talk's use case.

## 11. Emerging broader research vocabulary

Source: [Feng et al., Graph Engineering in the Era of LLM Agents: From Individual Intelligence to System Intelligence](https://arxiv.org/abs/2608.21156), arXiv preprint, submitted 2026-08-21, revised 2026-08-26. Abstract inspected; use only for the scope/terminology claim below.

Supported claim: the authors propose graph engineering as an emerging paradigm using explicit, dynamic, evolving structures to represent tasks, agents, and system states, organize work, and coordinate heterogeneous components. They present a systematic review of principles, methods, and applications.

Presentation use: a source note can acknowledge the wider umbrella, then explain that this presentation concentrates on enforced workflow transitions, recovery, and evidence.

Caveat: this is a recent preprint and proposed framing, not an established standard or demonstrated reliability guarantee. Do not repeat its broad claims about fundamental limits of individual agents as settled fact. It is not necessary to adopt multi-agent complexity to apply the workflow principles in this talk.

## Non-coding running example (illustrative)

The finished deck uses a customer reply: gather order facts → agent drafts → validate details → a person approves the exact version → send through a guarded service.

Wrong order detail: repair the draft, then recheck. Order data unavailable: no send. Timeout while sending: reconcile delivery status or retry idempotently; no blind duplicate message. Changed draft: repeat validation and approval. Retry budget exhausted: a person takes over. This is an illustration, with no invented company policy or threshold.

## Phrases that keep the talk accurate

- “Predictable rules around unpredictable work.”
- “A failed check changes the route. It does not lower the bar.”
- “No evidence, no transition.”
- “The agent can propose. The system decides what is permitted.”
- “A graph makes the process explicit. Its checks determine what it can establish.”

Avoid “graphs make AI deterministic,” “a second agent verifies truth,” “automatic retries guarantee success,” or “prompting is obsolete.” Prompts still matter inside each step; they should not be the only enforcement mechanism for mandatory rules.
