# Simulator workflow sources

Point-in-time research read on **2026-10-02**, rehomed from the selected model authors’ source notes. These are evidence boundaries, not live integrations or replicated studies. Published examples expose the same source facts, graph abstraction and proposed extensions separately. Model fixtures are hypothetical. Private Google Docs remain unverified. Numeric research/vendor claims are author-reported, not local results.

## 1. Conveyor belt

### Reopened primary URLs and access boundary

- Template: https://docs.google.com/document/d/1ByrrhaEHEv4EClbYKHN02hnYpaGg3GaFO6qi4irqgFs/edit <!-- secret-scan:allow Provided UNVERIFIED Google Doc reference ID; authentication still required, not a credential. -->
- Example initiative: https://docs.google.com/document/d/1mknB7zooYhvPSXUGJst0v87wAlsa7OzX0IlLL2yzriA/edit <!-- secret-scan:allow Provided UNVERIFIED Google Doc reference ID; authentication still required, not a credential. -->

Both static reads performed here on 2026-10-02 returned **HTTP 401**. Coordinator reports its actual available browser profile opened the template and redirected to Google Docs **Sign-in**, requesting email/phone. That browser observation belongs to coordinator; this worker did not obtain authenticated contents. Private document date/version/content therefore remains **unknown**.

### Documented features

**None verified from private contents.** Do not cite private summaries as reopened documentary facts.

### Supplied summary: UNVERIFIED context

The supplied attachment describes Brainstorm → H3 Radar → H2 Shaping → H1 delivery preparation → H0 Delivery → post-launch learning; progressive evidence/requirements/readiness and human specialist commitments. It also describes the Knowledge Graph initiative handoff: editorial declares a subject ready, editorial and engineering jointly check a source sheet, then validated import. These are **supplied-summary-only, UNVERIFIED** descriptions. The claim that the Google Doc is canonical initiative content and Shortcut operational progress likewise remains summary context; this prototype does not integrate either service.

### Our graph abstraction

Parent lifecycle calls shaping, preparation, delivery and learning children. Shaping calls stakeholder, technical and design/editorial children; stakeholder calls a nested question register. Pending stakeholder knowledge explicitly returns `awaiting input`; the parent schedules technical and design work before a genuine readiness join WAIT. This is sequential single-stack scheduling of independent branches, **not distributed parallelism**. Produced technical evidence can remain unresolved and return `investigate` through shaping to parent revision.

### Proposed extensions

All agent questioning/synthesis/assistance, version registers, dimension-specific invalidation, remembered exclusions/dissent, bounded technical probes and human learning-driven reshape are proposed. Joint commitments, editorial declarations and joint source-sheet checks bind initiative version; stakeholder knowledge binds direction version; positive specialist evidence binds design version; technical evidence binds technical version. Technical-only rework preserves stakeholder/design decisions. Learning-direction change preserves unaffected technical evidence and reopens stakeholder/design contributions. Each genuine new technical CALL initializes its two-probe local budget in the one shared scratch object; local loops, return consumption and retained branches do not reset it. The global revision cap remains 3. These version guards and invocation-local budget corrections are intentional production adaptations, recorded separately from the frozen producer source. No real import or delivery occurs.

### Native lifecycle fixtures / waits

- Preset **1**, success: nested questions → sufficient shaping → current hypothetical commitment → editorial declaration + joint sheet check → simulated validated import → simulated delivery validation → human outcome interpretation. Expected terminal `workflowStatus: outcome interpreted`; impact independently follows `impact`, so inconclusive/negative evidence does not become `outcomeAchieved`.
- Preset **2**, rework: first technical scope produces an artifact but stays unresolved after two probes. Child returns unresolved; shaping returns investigate; parent increases initiative/technical version and rechecks **technical only**, starting a fresh local probe budget. Stakeholder/design judgments and excluded expansion remain. Wait **`life.cbCommit`**, set **`commitment = version 2 committed`**; then **`preparation.cbEditorialReady`**, set **`editorial = initiative 2 declared ready`**; then **`preparation.cbSheetCheck`**, set **`sheet = initiative 2 both checked`**; later **`learning.cbInterpret`**, set **`interpretation = version 2 interpreted`**. These are exact native options, not internal autoresume.
- Preset **3**, human WAIT: stakeholder knowledge pending returns from question/stakeholder branch, technical/design complete independently, then **`shaping.cbJoin`** waits. Set **`stakeholderKnowledge = direction 1 supplied`** to resume this same episode. No unrelated future request is preanswered by that resume operation.
- Preset **4**, extra direction reshape: `interpretation = reshape once` requests learning feedback. First **`design.cbDesignDecide`** waits for **`designInput = design 2 supplied`**; then **`shaping.cbJoin`** needs **`stakeholderKnowledge = direction 2 supplied`**. Initiative 2 commitment, editorial declaration, joint source-sheet check and outcome interpretation use the same current-version inputs as preset 2. Prior technical evidence/probe count remains valid for unchanged technical scope. Prior design judgment/exclusion remains historical, not a new version's authority.
- Design's explicit `unresolved`, editorial `defer` and sheet `reject` remain non-success alternatives. Missing or mismatched positive contributions WAIT at their own step, without spending revision/probe budgets. Native current input resumes that step; Back restores the exact previous execution and shared scratch while retaining the current inputs.
- Initiative-native commitments, editorial declarations, source-sheet checks and outcome interpretations support versions **1–4**, the complete range under the unchanged three-revision cap. `technicalEvidence = always unresolved` gives exactly two probes in each of four technical invocations, then human handoff. `validation = always fails` rechecks technical scope while retaining stakeholder/design authority; supply current initiative inputs at each preparation, and changing validation to `validated` at version 4 permits explicit `interpretation = version 4 interpreted`.


## 3. Conversational UX co-analysis

### Primary source/version and exact read boundaries

- https://arxiv.org/abs/2603.13717 — abstract reopened.
- https://arxiv.org/html/2603.13717v1 — full paper reopened, **v1 14 March 2026**, CHI 2026, DOI https://doi.org/10.1145/3772318.3790536 .

Title: **“It Became My Buddy, But I’m Not Afraid to Disagree”: A Multi-Session Study of UX Evaluators Collaborating with Conversational AI Assistants**. Read date 2026-10-02. Read abstract/introduction/related background and specifically **§3.1–3.4 assistant design, §4 Usability Analysis Tool, §5.1 Participants, §5.2 Study Videos, §5.3 Procedure, §5.4 Data Analysis**; inspected beginning §6 analysis behaviors and **§7.1–7.3 discussion/limitations, §8 conclusion**. No requirement to read every empirical table/bibliography or to independently validate authors' performance claims. No quantitative performance claims replicated locally.

### Documented features

- §3.2: researchers use recordings' transcripts (corrected for errors/timestamps), product screenshots and user tasks to pre-generate problem/cause/redesign suggestions. These are recordings of **real users**, not synthetic users producing usability evidence.
- §3.1/3.3: custom novice/experienced assistants described as GPT-4V based for pre-generated suggestions; reactive responses use OpenAI `gpt-4-0613`. These are paper point-in-time versions, not current system claims.
- §4: video player, problem table, chat; suggestion **Accept / Edit / Ignore**, manual **Add Problem**; timestamp click navigates to evidence; authorship icons distinguish assistant, human and combined edits. Human interpretation/editing is documented baseline, not merely approval.
- §5.2: 15 real-user recordings across desktop website, smartphone app and VR headset; §5.1/5.3 report twelve evaluators/five sessions. This local model uses only clearly hypothetical source references, does not possess/play original recordings, and does not run any study.
- §7 describes critical engagement and filtering AI suggestions; author-reported study outcomes remain author-reported, not universal guarantee or replication.

### Our graph abstraction

Analysis produces a source-bound suggestion, human inspects evidence, nested dialogue obtains evaluator question and simulated response, nested audit inspects timestamp context, then human interprets or rejects. Produced reply and answered question can be true while evidence sufficiency is false. An unsupported suggestion cannot enter the confirmed register even if a hypothetical acceptance input was supplied.

### Proposed extensions

Evidence/finding versions, bounded explanation/revision, durable rejection rationale/exclusions, selective affected reinspection and parent new-evidence feedback are proposed. **Baseline already includes redesign recommendations**: the extension is linking a confirmed finding to an accountable versioned design decision and planning later real-participant validation. That future plan is not executed, and terminal recording never asserts improved usability (`outcomeAchieved: false`). An unrelated prior hypothetical finding B and population-wide-prevalence exclusion remain remembered after target A changes.

### Native lifecycle fixtures / waits

- Preset **1**: suggestion → human inspection → nested question/audit → human-supported interpretation → proposed owned design hypothesis → future real-participant validation plan. Expected **`findings and follow-up recorded`**, study **not run**.
- Preset **2**: first evidence version is unsupported; after two explanations the human input explicitly rejects finding 1. Parent revises only relevant target evidence to version 2, retaining rejection rationale, unrelated B and excluded prevalence claim. Wait **`analysis.uxInterpret`**, set **`evaluatorDecision = finding 2 interpreted`**; later wait **`followup.uxDesignDecision`**, set **`designDecision = finding 2 linked`**.
- Preset **3**: **`dialogue.uxQuestion`** waits for **`evaluatorQuestion = ask for timestamp evidence`**. No assistant invents the human challenge/question.
- Preset **4**: always-unsupported source remains insufficient despite a hypothetical interpretation input; human research handoff, no confirmed target finding.


## Magentic-UI

Primary publication reopened in full reader output, including architecture, co-planning/co-tasking, action guards, plan learning and safety sections:

https://www.microsoft.com/en-us/research/blog/magentic-ui-an-experimental-human-centered-web-agent/

**Version:** published **2025-05-19**; reader exposes page `modified_time` **2026-05-05T18:17:06+00:00**. Read **2026-10-02**. These are publication/page dates, not a pinned current repository release.

### Documented features

- “Collaborative planning with users (co-planning)” allows direct plan-editor modification or textual feedback before execution. Architecture section describes adding, deleting, editing and regenerating steps; the orchestrator stores the plan.
- “Collaborative execution with users (co-tasking)” allows pause, natural-language feedback and direct browser takeover/demonstration. Co-tasking description explicitly says users may take control and give control back.
- Orchestrator chooses an agent or the user for a step, requests work, waits for a response and decides whether the step is complete. An inadequate plan can trigger replanning with user permission.
- Action guards seek permission for consequential actions; users configure approval frequency. Plan learning lets users save, view, modify and reuse learned plans.
- Publication’s GAIA evaluation is an author-reported automated **simulated-user** experiment. No metrics are imported into this graph and nothing was locally replicated.

### Our graph abstraction

`life` calls `coplan`, then `execution`; `execution` calls `teacher`. These are our graph IDs, not upstream state names. Teacher visibly takes control, awaits a demonstration, separately awaits return of control, returns to the caller, and agent resumes. Consequence check follows resumption. Failed consequences return `inadequate` and cause a genuine parent `replan` → `planCall` cycle.

Demonstration input is **not an approval**: native `demonstration` values mean the teacher supplied a performed control sequence for a particular plan version. `handback` is a separate contribution. No browser is actually driven by this graph, and the model does not infer a teacher action from Next/Run.

### Proposed extensions

Versioned co-plan, demonstration, consequence and pending work records; an illustrative two-plan cap; selective invalidation of navigation/demonstration evidence while retaining the unchanged `no purchase` exclusion with owner/rationale/reopen condition. These precise authority and version rules are our additions, not claims about Magentic-UI’s internals. Saved plan is episode memory only, not its actual gallery.

### Exact native expectations

Source module: `articles/assets/workflow-models/magentic-ui.mjs`.

- Preset **1**: hypothetical version-1 plan edit, demonstration and handback already supplied. Real CALL/RETURN through `coplan`, `execution`, and nested `teacher`. Expected terminal `workflowStatus`: **`co-task completed simulated`**.
- Preset **2**: `consequence='mismatch once'`. First execution returns inadequate; parent revises plan, retaining no-purchase decision and logging affected invalidation. Three separate current-version WAITs, answered only at their own nodes:
  1. `coplan.planEdit`: `coPlan='revision 2 edited'`.
  2. `teacher.demonstrate`: `demonstration='revision 2 demonstrated'`.
  3. `teacher.handback`: `handback='revision 2 returned'`.
  Expected terminal after those inputs: **`co-task completed simulated`**. `smoke.reworkResumeAt` records those separate requests.
- Preset **3**: `demonstration='pending'`. Expected native position **`teacher.demonstrate`**, `waiting=true`, teacher control remains held, no plan retry spent. `smoke.resumeAt` contains ONLY this requested teacher input: `demonstration='revision 1 demonstrated'`. Existing explicit hypothetical version-1 handback is not silently fabricated. Expected terminal after release: **`co-task completed simulated`**.
- Pending or old-version co-plan/demo/handback never matches a current version. Explicit `defer` routes through child deferred return to **`human co-task handoff`**. Persistent mismatch exhausts illustrative plan budget and hands off, never manufactures success.

## Open SWE: published 2025 architecture

Primary publication reopened:

https://www.langchain.com/blog/introducing-open-swe-an-open-source-asynchronous-coding-agent

**Version:** publication **2025-08-06**; read **2026-10-02**. No latest GitHub repository implementation was used to reinterpret this dated architecture; linked current repository is not evidence for this historical shape.

### Documented features

- “How It Works: The Agent Architecture” explicitly describes **Manager → Planner → Programmer**, with **Reviewer** as Programmer’s sub-agent. Manager initializes task context and routes to Planner; Planner researches and builds steps; Programmer works in sandbox; Reviewer checks quality/correctness/completeness and returns feedback to Programmer for iteration.
- “Control” describes accepting, editing, deleting or requesting changes to the plan and asking it to continue research/restart planning.
- “Double texting” describes sending new requests or feedback while work is running, including changed product specification or additional features, without restarting the session.
- Source says reviewer-approved work leads to a conclusion and PR. Its wording “until the code is perfect” is publication rhetoric, not a completeness guarantee; our graph never treats arbitrary agent agreement as real delivery proof.

### Our graph abstraction

Manager is `life`; actual child calls go to `planner` and `programmer`; Programmer actually calls `reviewer`. A human plan editor contributes a current-version step edit or deletion; requesting further planning loops to research. Code is produced before the running-task input is settled. Clarification continues the same task; scope change returns to Manager, where affected plan/code/check records are invalidated and a new Planner call occurs. Reviewer findings cause a genuinely local Programmer loop, not parent restart. Final output is a memory-only reviewed package at an **unexecuted PR boundary**.

### Proposed extensions

Exact clarification-versus-scope classification, version invalidation and current-version contribution requirements are policy additions: the primary source establishes acceptance of mid-flight input, **not this precise stale-evidence policy**. A security owner’s unaffected `no credential changes` decision survives a navigation scope revision. Global planning cap 3 and local Programmer/Reviewer cap 2 are illustrative, not source-specified. Deferred/capped work hands off to a human engineer, not a fake PR.

### Exact native expectations

Source module: `articles/assets/workflow-models/open-swe.mjs`.

- Preset **1**: hypothetical prior version-1 human edit and mid-flight clarification. Planner CALL/RETURN, Programmer CALL, nested Reviewer CALL/RETURN. Expected terminal: **`reviewed change package simulated`**.
- Preset **2**: `feedback='scope change supplied'`, `review='repair once'`. Code version1 is produced, then human message returns `scope changed`. Manager’s affected revision invalidates navigation evidence and preserves security decision. Native WAIT **`planner.humanPlan`**, `planContribution='revision 2 edited'`. Then new Programmer invocation performs one Reviewer-requested local repair, followed by a sufficient review. Expected terminal: **`reviewed change package simulated`**. `smoke.reworkResumeAt` records this single requested replanning contribution.
- Preset **3**: `feedback='pending'`. Native WAIT **`programmer.followup`** with produced code artifact but `questionAnswered=false`, evidence/stage insufficient. `smoke.resumeAt`: ONLY `feedback='clarification supplied'` at that node. Expected terminal after release: **`reviewed change package simulated`**, same plan version.
- `planContribution='request replan'` performs actual bounded research feedback; no automatic acceptance after exhaustion. Pending/stale human edits WAIT without spending a retry. Always-repair Reviewer exhausts local rounds and routes **`human engineering handoff`**. Explicit defer likewise hands off. No tests, formatters, code agent, push, tracking issue or PR execute locally.


## Collaborative grilling

### Primary facts / evidence boundary
- Supplied collaborative-grilling catalogue design context, example 2 and its design properties, read 2026-10-02.
- This is a **proposed pattern**, not a documented existing published execution. There are deliberately **no documentedFeatures claims**. https://github.com/mfittko/dev-loops is a context link only; no repository implementation claim is made.
- Source version: supplied catalogue as read 2026-10-02.

### Our graph abstraction
- Knowledge child returns `awaiting input` while independent scrutiny continues, nesting a factual investigation child. A later parent readiness join genuinely waits for missing owner knowledge.
- Factual unknown, stakeholder knowledge, accountable preference and joint conflict have distinct routes. Product owns scope; Product + Engineering own joint resolution. Agents cannot announce their agreement or commitments.
- Artifact produced, question answered, evidence sufficient, decision recorded, stage ready and outcome achieved are distinct inspectable record fields.
- Sequential scheduling of independent branches is **not actual distributed concurrency**.

### Proposed extensions
- Entire graph, question register and stage policy are proposed: versioned owner/evidence/answer/rationale/dissent/reopen rules; preserved exclusions and accepted Radar-only scheduling risk.
- Rollout change selectively reopens factual/tradeoff/conflict questions; stakeholder audience knowledge and exclusions are unchanged and retained with original provenance/version.
- Radar readiness does not manufacture Delivery commitment. Delivery requires explicit supplied commitment evidence. Outcome achievement remains false because no delivery/measurement occurs.

### Native fixtures / handoff
- Preset 1: nested CALL/RETURN and explicit hypothetical prior contributions → `stage ready`.
- Preset 2: deliberation `RETURN revise` → parent proposal v2 → affected rechecks → `deliberation.grillTradeoff` WAIT. Supply **freshTradeoff = proposal 2: accept bounded scope**, then separately **jointInput = proposal 2: joint resolution recorded**. Production intentionally repairs the source's unversioned decision guards; the source's immutable hash remains provenance of the input, not of the repaired handlers.
- Preset 3: knowledge returns pending → independent factual work → `life.grillJoin` WAIT. Set **stakeholderInput = knowledge supplied**.
- At `deliberation.grillConflict`, pending or another proposal's joint input remains WAIT. A proposal-2 scope revision returns to parent proposal 3, requiring **freshTradeoff = proposal 3: accept bounded scope** and **jointInput = proposal 3: joint resolution recorded**. Prior knowledge, exclusions, accepted risk and dissent remain intact. Waiting consumes no revision/evidence budget; defer/reject/capped handoff are not readiness. This entire version-bound policy remains PROPOSED.

## Playwright test agents

### Reopened primary facts
Source: https://playwright.dev/docs/test-agents — stable official documentation read 2026-10-02; no package version inferred.
- Introduction: planner, generator and healer may be used independently, sequentially or chained.
- Planner: explores application; seed test sets up environment; PRD optional; produces human-readable Markdown plan with scenarios and expected outcomes.
- Generator: transforms Markdown plan into Playwright tests, verifies selectors/assertions live.
- Healer: replays failure, inspects UI, suggests locator/wait/data fixes, reruns until pass or guardrails. **Documented output may be a skipped test if functionality is believed broken**, not necessarily a passing test. This fact is retained rather than silently presented as strict human-gated upstream behavior.
- Definitions consist of instructions and MCP tools and should be regenerated on Playwright updates. Not implemented/run in this local graph.

### Our graph abstraction
- True planner/generator/healer child graphs, healer nesting diagnosis. Hypothetical deterministic execution provides status, not actual tests/browser work.
- Plan produced is separate from human intent, generated tests, versioned execution evidence and stage readiness.
- Test-mechanics repair loops replay the same preserved expected outcome.

### Proposed extensions (not official baseline claims)
- Product actively coauthors/confirms versioned scenarios and intended outcomes. Engineer contributes causal explanation and routes test defect versus application defect versus changed requirement.
- Real application regression cannot be healed by weakening expected assertions or treating skip as success: it returns unresolved engineering handoff.
- Changed requirement returns parent revision and replanning of affected checkout only, retaining independent sign-in intent and excluded destructive-flow rationale. Fresh human contribution required.
- Illustrative caps: three intent versions/two repairs, **not documented numeric Playwright policy**. Passing selected intended checks is not coverage completeness/product correctness.

### Native fixtures / handoff
- Preset 1 → `intended scenarios validated (simulated)`; outcomeAchieved remains false.
- Preset 2: requirement change → intent v2 → `life.pwIntent` WAIT. Set **freshIntent = revised scenarios and outcomes confirmed**.
- Preset 3: initial `life.pwIntent` WAIT. Set **intentInput = scenarios and outcomes confirmed**. Use current requested role/version only; do not pre-answer future contributions.
- Engineer wait: `diagnosis.pwEngineer`, **engineerInput = explanation supplied**.
- Preset 4: nested diagnosis/test-mechanics local repair; 5: product defect handoff preserving assertion; 6: repair cap.

## Meta ACH

### Reopened primary facts
- https://engineering.fb.com/2025/02/05/security/revolutionizing-software-testing-llm-powered-bug-catchers-meta-ach/ — published **2025-02-05**, read 2026-10-02. Engineer plain-text concern → generated concern-specific mutants → generated tests catching those faults. Author industrial claims are not local replication. <!-- secret-scan:allow Official public Meta Engineering article path, not a credential or signed URL. -->
- https://arxiv.org/html/2501.12862v1 — **arXiv:2501.12862v1, 2025-01-22**, read 2026-10-02, especially §§1–6.
- §1: buildability, consistent original-code pass and previously uncaught-fault detection are boolean test assurances; relevance and coding-style fit are subjective/aspirational and assessed in engineer review.
- §§2–3: concern-specific fault generation; existing-test survivors; syntactic filtering and fallible LLM equivalent-mutant detection; survivor mutants prompt targeted tests. LLM non-equivalence judgment is not mathematical equivalence proof.
- §4: engineer review/test-a-thon evaluation; concrete mutants help humans understand behavior, and tests may offer benefits even when not judged privacy-relevant.
- §5: equivalent-mutant detection limitations, including comment-only misleading mutants and preprocessing; no claim of perfect equivalence classification.
- §6: selected mutant detection can add value without additional line coverage. No empirical percentages/metrics presented as locally observed.

### Our graph abstraction
- Human concern → mutant child nesting survivor screen → targeted-test child nesting deterministic validation → engineer interpretation child.
- Hypothetical buildability, original pass and selected mutant failure feed validation; passing original is mandatory even when selected mutant is caught.
- Produced tests and selected-detection evidence are distinct from human relevance interpretation and readiness. `faultClassProven` is always false.

### Proposed extensions (not Meta baseline claims)
- Explicit concern/version authority, pending human WAIT, active relevance interpretation/calibration and selective rechecks.
- Revised disclosure concern selectively reopens disclosure probe; unrelated access boundary, rejected comment-only equivalent probe and performance exclusion remain with original rationale.
- New concern / reject / defer / cap are genuine returned outcomes. Three versions/two candidates are illustrative local limits.
- Detection of selected mutants **does not prove the entire fault class impossible**; no real code/test/CI run occurs.

### Native fixtures / handoff
- Preset 1 → `selected faults hardened (simulated)`; broader adequacy and outcome achievement remain unproven/false.
- Preset 2: human interpretation `RETURN new concern` → parent concern v2 → `life.achConcern` WAIT. Set **freshConcern = revised concern authored**.
- Preset 3: detection evidence ready but `interpretation.achHumanInterpret` WAIT. Set **interpretation = valid relevant tests**.
- Initial concern wait: `life.achConcern`, **concernInput = concern authored**. Only supply the requested current version input.
- Preset 4: invalid-first candidate local repair; 5: candidate cap; 6: explicit unsupported-relevance rejection despite selected detection.


## EvalGen

### Reopened primary sources and point-in-time scope

- Abstract record: https://arxiv.org/abs/2404.12272
- Primary paper read: https://arxiv.org/html/2404.12272v1 — *Who Validates the Validators? Aligning LLM-Assisted Evaluation of LLM Outputs with Human Preferences*, Shankar et al.; arXiv v1 dated **2024-04-18**. Read introduction, design, implementation, user-study findings, discussion, limitations and algorithm appendices. This is v1 research, not a claim about current ChainForge implementation.

**Documented:** §3.1 describes editable/deletable/addable natural-language criteria, code/LLM implementation choice, sample good/bad grading while candidate assertions are synthesized and executed, and alignment report cards. §4 describes asynchronous candidate generation/execution and human grades guiding selection. §7.3.1 identifies criteria drift: adding new criteria required finishing execution/reporting and starting a new EvalGen process; users also reinterpreted existing criteria and changed grades. §§7.4 and 8 discuss limits of trust, collaborator grading and possible future refinements. The paper does not establish our selective artifact-dependency invalidation policy.

**Graph abstraction:** four actual child graphs (criteria, grades, candidates, alignment). The single-stack scheduler lets the grading child RETURN `awaiting input`, truly CALLS/RETURNS independent candidate creation, then globally waits at a version/evidence join. This demonstrates independent continuation, **not actual distributed concurrency or paper algorithm execution**.

**Proposed extension:** relevance criterion versions, criteria-owner example contributions, version-bound human grade/calibration rationale, selective invalidation of relevance grades/evaluator/decision, preserved format v1 and excluded latency rationale. Our per-criterion grade/version fields are not a reproduction of v1's aggregate thumbs-up/down grading interface. Candidate inspectability and sample alignment are qualitative fixture inputs. No numeric alignment, confusion matrix, coverage rate, empirical accuracy or local replication is invented.

### Native scenarios / expected behavior

- Preset 1: human criteria coauthor contribution, sample grades, candidate creation and alignment child CALL/RETURNs; terminal `workflowStatus = simulated evaluator calibrated`. Outcome refers only to a **hypothetical sampled calibration**, never universal production trust.
- Preset 2: local candidate repair; alignment RETURNS `drift`, parent loops to revised affected relevance criterion v2, clears only its grade/evaluator/alignment/decision versions, receives explicit hypothetical v2 criteria/examples and regrades, regenerates affected evaluator, then calibrates. Unaffected format decision and excluded latency persist. Same expected success status.
- Preset 3: grading RETURNS pending, evaluator is produced first, then WAIT at `life.gradeJoin`. Native `sampleGrades = graded v1 with rationale` releases only sample-grader request; it re-enters actual grading child while retaining current evaluator. WAIT spends no retries.
- Other WAIT nodes: `criteria.criteriaAuthor` -> `criteriaInput = coauthored v1 with examples`; `alignment.alignmentInspect` -> `calibration = inspected sample alignment`. Preset 4 unknown alignment produces `human evaluation handoff`, despite artifacts and answered grades.
- Additional failure/defer/reject/cap paths do not manufacture calibration.

## UXAgent

### Reopened primary sources and point-in-time scope

- Official project page: https://uxagent.hailab.io/ — static HTML is a JavaScript shell. Reopened its referenced `https://uxagent.hailab.io/assets/index-BVEJHlGw.js` to read the project description and actual official paper/repository links; **did not invoke the live demo/chat/backend**.
- Linked primary paper: https://arxiv.org/html/2504.09407v1 — *UXAgent: A System for Simulating Usability Testing of Web Design with LLM Agents*, Lu et al.; v1 dated **2025-04-13**. Read architecture §§3.1–3.4, study procedure/results §4 and discussion/limitations §5.
- Linked official repository README: https://github.com/neuhai/uxagent — read **2026-10-02**. No commit SHA observed, so not asserting current source-code runtime behavior.

**Documented:** paper §§3.1–3.3 describe persona generation, LLM agents, a browser connector, and action/reasoning traces. §3.4 describes replay and agent interviews as researcher interfaces. §4.3.1 describes researcher procedure/measurement interpretation and proposed revision (e.g. richer action categories). §5.3 explicitly warns against substituting synthetic behavior for actual human participant data; §5.4 says quantitative comparison of agents versus real humans was not performed. README documents configurable personas, intent, questionnaire and output artifacts, but its installation/browser tooling differs from the paper's dated architecture: no assertion here that Selenium from paper v1 is current repository practice.

**Evidence conflict:** the current project-site text reports a different heuristic participant count than v1's five UX researchers. The model deliberately claims **neither count nor any study metric**, and keeps v1 facts date-qualified. Author-reported synthetic session outcomes are not local results and are not modeled as measurements.

**Graph abstraction:** parent study authorship -> rehearsal child -> human interpretation child -> future real-participant boundary. Rehearsal genuinely CALLS a connector-check child. Connector fixture checks only inspectability, not measurement validity or actual webpage compatibility.

**Proposed extension:** task/measurement artifact revisions, human current-version interpretation/rationale, selective synthetic-log/decision invalidation, explicit WAIT/defer/reject and preserved consent boundary/research question. Success is rehearsal-procedure preparedness; actual-user evidence remains false and real-participant study remains not conducted.

### Native scenarios / expected behavior

- Preset 1: rehearsal CALLS connector, synthetic logs RETURN, human researcher interpretation RETURNS `prepared`; terminal `workflowStatus = study rehearsal prepared`.
- Preset 2: connector missing-event fixture rechecks once locally; researcher RETURNS meaningful task/measurement correction, parent revises to procedure v2 and re-rehearses affected artifacts with explicit hypothetical v2 contribution. Unchanged research question and future-participant consent boundary survive. Same expected success status.
- Preset 3: WAIT at `interpretation.researchInterpret`; native `researcherInput = interpreted v1 with rationale` resumes human researcher interpretation. No other role is auto-answered.
- Additional human-author WAIT: `life.studyAuthor` -> `studyInput = authored v1 tasks and measurements`.
- Unsupported `synthetic proves actual users` input returns a non-ready human handoff; unavailable connector returns blocked, not fabricated logs.

## QA Wolf Mapping AI

### Reopened primary source and point-in-time scope

- https://www.qawolf.com/blog/teaching-an-agent-to-think-like-a-tester-how-we-built-mapping-ai — *Teaching an Agent to Think Like a Tester: How We Built a Product-Mapping AI*, **Carly Gradeff, 2026-09-01**, reopened **2026-10-02** in full.

**Documented:** architecture section describes browser exploration generating raw events for outline and world-model pipelines, with feedback guiding exploration. Challenge 4 describes decoupling exploration from outline writing. Challenge 5 specifies durable **Published, Draft, Rejected** states, conventional-code candidate-to-existing-coverage matching, and retained earlier rejection decisions/reasons so remapping does not resurrect excluded noise. Challenge 2 gives navigation-only/non-interactive examples as low-value flows. This is the dated article's architecture, not a claim that we ran the service or inspected private production implementation. Article speed/flow-count/test-volume figures are author-reported and intentionally not rendered as local metrics.

**Graph abstraction:** actual exploration, deterministic reconciliation and human curation child graphs; real parent repeated mapping cycle. Exact fixture flow-ID/version matching is implemented in conventional JS. No LLM claims correspondence. In-memory history lasts within an episode and is reset by Reset; no external persistence added.

**Proposed extension:** explicit behavior dependency versions; relevant display-to-interactive banner change selectively reopens its exclusion while keeping old rationale, published checkout/profile decisions, and navigation rejection; explicit current-version QA-owner curation, questions, rationale, WAIT/defer/reject and scoped completeness interpretation. These exact dependency/version/authority fields are ours, not asserted as article details.

### Native scenarios / expected behavior

- Preset 1: initial candidates reconcile against published checkout/rejected display-only banner. Human publishes profile and rejects navigation-only noise with rationale. Parent performs a genuine second mapping CALL/RETURN cycle at the same version; matching preserves published identities and rejected banner/navigation. Terminal `workflowStatus = simulated coverage map reconciled`.
- Preset 2: parent second cycle changes banner from decoration to an interactive preference behavior. Only that behavior dependency reopens; former exclusion rationale remains inspectable, unrelated published/rejected decisions survive. Explicit hypothetical v2 human rationale publishes the affected flow. Same expected success status.
- Preset 3: WAIT at `curate.curateDecision`; native `curationInput = curated v1 with rationale` resumes only current QA-owner contribution. WAIT does not consume mapping budget.
- Known scoped coverage gaps produce `human QA handoff` even when candidates, decisions and artifacts exist. No test executes or passes locally.


## Primary publications reopened

### GOV.UK: Using moderated usability testing

https://www.gov.uk/service-manual/user-research/using-moderated-usability-testing

Observed public dates: published **2017-02-21**, last updated **2017-10-03**. Read **2026-10-02**. Reader also exposes rendering-system updated metadata from September 2026; this is **not substituted for the public substantive update date**.

Direct support:

- Agree research questions, user types and prototype/service areas with the team before planning sessions.
- Moderated usability testing observes actual/likely users trying tasks. Tasks should be relevant, believable and neutral rather than giving away answers.
- It can test prototypes or the service already built, and assistive-technology research needs appropriate participant/device context.
- Dummy data has limitations; it does not establish the same contextual evidence as people using their own data.

Boundary: our native conditions represent **hypothetical human-supplied observations**, not an executed study and not agents simulating real participants. No participant recruited, session run, personal data collected or checkout/payment performed.

### GOV.UK: Analyse a research session

https://www.gov.uk/service-manual/user-research/analyse-a-research-session

Observed public dates: published/updated **2016-05-24**. Read **2026-10-02**.

Direct support:

- Invite observers into collaborative analysis and use recorded/source evidence to confirm observations.
- Record exactly what was seen/heard separately from what it means; determine findings, then decide actions.
- Findings can lead to design ideas, new research questions, prototype revisions or changes in scope/user stories.

Boundary: version-scoped interpretation and return routing are our policy additions. The graph records observation artifact, researcher finding/rationale and next action separately. It never calls generated prototype output a user finding.

### GOV.UK: How to set performance metrics for your service

https://www.gov.uk/service-manual/measuring-success/how-to-set-performance-metrics-for-your-service

Observed public date: published **2017-12-05**. Read **2026-10-02**.

Direct support:

- Define purpose, benefits and hypotheses before selecting measurements; involve performance analysis from discovery.
- Combine metrics with user research; collect/analyse accurate data with context, segmentation and a baseline.
- Iterate using evidence; multiple data sources help explain what happened, why and what to do next.

Boundary: government-specific reporting/KPI obligations are **not imported into a commercial checkout**. The graph has no numerical baseline, effect size, conversion metric or significance claim. Its qualitative result fixtures explicitly remain hypothetical. Release alone does not establish outcome success.

### W3C WAI: Forms Tutorial

https://www.w3.org/WAI/tutorials/forms/

Read **2026-10-02**; no unobserved publication/version date inferred.

Direct support:

- Label controls, group related controls, provide instructions, validate input and communicate errors/success with correction instructions.
- Ask only for required information; excessive or irrelevant requests make forms harder to complete.

Boundary: source guidance is not proof our represented UI meets accessibility requirements. Graph check results are condition inputs, not real DOM/browser/test execution or certification.

### WAI: WCAG 2.2 Understanding Reflow, SC 1.4.10

https://www.w3.org/WAI/WCAG22/Understanding/reflow.html <!-- secret-scan:allow Official public W3C WCAG supporting guidance path, not a credential or signed URL. -->

Version qualifier: **WCAG 2.2 supporting Understanding guidance**, read **2026-10-02**. No content-update date inferred. Understanding documents explain the standard; do not treat this supporting article as an independent new normative requirement.

Direct support:

- Vertical content should reflow at a width equivalent to **320 CSS pixels**, without loss of information/functionality or two-dimensional scrolling, subject to specific two-dimensional-layout exceptions.
- Responsive adjustment should retain access to content and functionality. Exceptions do not automatically extend to all surrounding content.

Boundary: selected responsive/label/error/focus fixtures do **not** prove complete WCAG conformance. The graph does not execute a real viewport or assistive-technology inspection.

### MDN: Responsive web design

https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout/Responsive_Design

Read in full **2026-10-02**; no document revision date inferred.

Direct support:

- Responsive design uses flexible layouts, content-appropriate breakpoints/media queries and responsive media, rather than assuming a few fixed device sizes.
- Viewport configuration affects actual mobile rendering; relative sizing and flexible layout support varying widths.

Boundary: our flow uses represented frontend check results only. No frontend component app, CSS layout, browser checkout, backend, payment or deploy is executed by graph handlers.

### Additional reopened background

https://www.gov.uk/service-manual/user-research/using-in-depth-interviews

Public date **2017-02-21**, read **2026-10-02**. It supports learning users’ circumstances/problems through open, neutral questions and real examples. This was background research; the model’s cited claims and implemented study route use the moderated-usability and analysis guides above rather than inventing an interview implementation.

## Bespoke graph and original runtime protocol

Seven graphs, all through the existing original engine:

- `life`: problem → discovery → design → frontend → explicit release decision → represented release → measurement → supported learning / iterate / reshape / stop / human handoff.
- `discovery`: human problem-source input → actual `questions` child CALL → human Product/Designer/Frontend joint outcome/scope coauthorship → RETURN ready/investigate/deferred.
- `questions`: factual/authority question register → supplied source inspection → RETURN supported/unknown. Factual inquiry does not answer the human scope tradeoff; `jointScope` explicitly records that answer and its rationale/dissent.
- `design`: alternatives → human alternative choice/rationale → represented interactive prototype → actual `research` child CALL → RETURN ready/revise-design/reshape-product/deferred.
- `research`: neutral task context → native human-supplied observation WAIT → separate researcher interpretation WAIT → RETURN supports/revise/scope-unknown/deferred.
- `frontend`: own counter initialization → represented component build → responsive/accessibility/behavior result fixtures → classification. Code defects loop locally through fix/build/check. Design ambiguity RETURNS to parent Design; requirement ambiguity RETURNS to parent Product. Designer then inspects a specific **BUILT** artifact/version and observations, not a generic final approval of the plan/prototype.
- `measurement`: separate current-release evidence WAIT → human analyst/Product interpretation → RETURN supported/iterate/reshape/investigate/stop/deferred. No deployed artifact automatically achieves outcome.

Actual handler contract: `(s,w,f,ret)`; `s` read-only, state changes through returned `set`. `next:{sub,at}` pushes graph position, `next:{up}` returns outcome to **the SAME caller**, whose next invocation receives/interprets `ret`. Only `next:'END'` ends the **whole** workflow. No independent player, flat trace or shared-runtime rewrite introduced.

Current manifest corrects the earlier ephemeral fresh-frame description: original `S.f` is **one shared control object**. This model initializes ONLY `f.checkoutFrontendRounds` in `frontend.frontendStart`, then uses it for local fix budgeting. Nested discovery/research handlers do not overwrite it or siblings’ keys. Global artifact revision and measurement counters live in `s`, persist through feedback and never reset by returning to `life.request`.

## Authority, versions and readiness

Separate inspectable flags: `artifactProduced`, `questionAnswered`, `evidenceSufficient`, `decisionRecorded`, `stageReady`, `outcomeAchieved`. Generated artifact/answered question is never automatically sufficient/outcome-achieved.

Human work records carry owner, explicit question, artifact version, relevant evidence, pending/answered status and defer or escalation route. Missing input remains `waiting:true` at the same native node; Next/Run cannot supply consent. WAIT handlers spend no revision, build or measurement budget. Successful fixture inputs are **explicitly hypothetical prior human contributions**, not claims of real humans supplying answers.

Design revision invalidates affected design/prototype/research/build/check/designer-inspection/release/measurement/learning evidence and records why. It preserves current Product scope and unrelated decisions:

- Product/commercial owner’s unchanged pricing/tax/payment-rule decision, with rationale and reopen condition.
- Analyst’s unchanged instrumentation **definition**, with rationale and reopen condition. This is a remembered definition, not actual implemented collection or measurement.

Product reshape requires fresh problem evidence and fresh joint scope, and invalidates dependent design/delivery evidence. Unrelated rules/definitions retain their own versions only while their specified assumptions remain unchanged. No stakeholder acceptance, actual delivery commitments, user outcome or payment authorization is fabricated.

Bounds are proposed/illustrative: **two global artifact revisions**, **two frontend rounds per invocation**, **two measurement investigations**. Exhaustion transfers to a human team. Persistent ambiguity/failure never invents a passing check or a new requirement.

## Exact native fixtures and expected states

Common metadata: success preset **1**, rework preset **2**, human-WAIT preset **3**, `maxSteps:140`, expected supported fixture terminal `workflowStatus`: **`checkout learning recorded simulated`**.

### Preset 1 — supported learning fixture

Explicit hypothetical prior human source, joint scope, design choice, prototype observations/interpretation, build inspection, release decision and outcome evidence/learning.

Actual nested CALL/RETURN: `life → discovery → questions`, `life → design → research`, then frontend and measurement child returns. The represented release sets `outcomeAchieved=false`, `evidenceSufficient=false`, `stageReady=false`; only sufficient current-release measurement AND explicit analyst/Product interpretation lead to supported modeled learning. Terminal status above is not real conversion uplift.

### Preset 2 — frontend ambiguity returns to Design

`behaviorCheck='design ambiguity once'`.

First represented build is version **1**, design version **1**. Frontend RETURNS `design ambiguity`; parent `reviseDesign` invalidates affected evidence, retains Product scope/business rules/instrumentation definition, and genuinely CALLs Design version **2**. New represented frontend build is version **2**.

`smoke.reworkResumeAt` maps exactly **one requested native contribution per actual node**; supply each ONLY when that node waits, never pre-answer future versions:

| Native graph.node | Key | Exact option |
|---|---|---|
| `design.chooseAlternative` | `designChoice` | `design 2 alternative selected` |
| `research.sampleInput` | `prototypeEvidence` | `prototype 2 observations supplied` |
| `research.interpretStudy` | `researchInterpretation` | `prototype 2 interpreted support` |
| `frontend.inspectBuilt` | `builtInspection` | `build 2 inspected` |
| `life.releaseDecision` | `releaseAuthorization` | `design 2 release authorized` |
| `measurement.outcomeInput` | `outcomeEvidence` | `release 2 evidence supplied` |
| `measurement.interpretOutcome` | `learningDecision` | `release 2 supported learning` |

Expected terminal after all those current-version contributions: **`checkout learning recorded simulated`**.

### Preset 3 — actual human research WAIT

`prototypeEvidence='pending'`.

Expected position: **`research.sampleInput`**, `waiting=true`. Prototype artifact exists; `questionAnswered=false`, `evidenceSufficient=false`, `stageReady=false`, `outcomeAchieved=false`. No human session evidence is generated internally.

`smoke.resumeAt` contains ONLY:

- key **`prototypeEvidence`** → exact value **`prototype 1 observations supplied`** at **`research.sampleInput`**.

This supplies this researcher’s requested observations only; it does not pre-answer any future-version question. Other successful preset inputs remain explicitly hypothetical prior contributions. Expected terminal after release: **`checkout learning recorded simulated`**.

### Additional scoped fixtures

- Preset **4**: `responsiveCheck='code defect once'`. Local `checkComponents → classifyIssue → fixComponents → buildComponents` loop produces built version **2**, preserving scope/design version **1**. Native WAIT `frontend.inspectBuilt` requires **`builtInspection='build 2 inspected'`**. Remaining explicit prior version-1 contributions then allow supported modeled learning. This is not parent design rework and does not weaken intended assertions.
- Preset **5**: `outcomeSufficiency='insufficient'`. Represented release and supplied outcome artifact cannot prove benefit. Measurement RETURNS `investigate`; at the proposed two-investigation boundary expected terminal is **`human checkout team handoff`**, `outcomeAchieved=false`, `stageReady=false`.
- Requirement ambiguity routes `frontendProduct` → parent `reshapeProduct` → fresh discovery/current scope, rather than agents inventing requirements. Native inputs `problem 2 evidence supplied`, `scope 2 jointly authored` and current-design contributions are needed. Human `iterate design`, `reshape product`, `investigate further`, `stop` and `defer` are distinct next-action outcomes.


## Production incident response

Research/read date: **2026-10-02**. Production data module: `articles/assets/workflow-models/incident-response.mjs`. Frozen producer source SHA-256: `5ceefea9166c996386b31858d6e490c189c0c14aa0941694d33ae80466ef4d3e`. Its root canvas retains the producer-authorized x0=180/viewBox-width=1440 correction; node/edge relationships and handlers are unchanged.

### Reopened primary sources and point-in-time scope

- **Google SRE Book, chapter 12: Effective Troubleshooting**, written by Chris Jones: https://sre.google/sre-book/effective-troubleshooting/ . Public online chapter, copyright © 2017 Google, published by O'Reilly Media; no numbered web revision or page publication date inferred.
- **Google SRE Book, chapter 14: Managing Incidents**, written by Andrew Stribblehill and edited by Kavita Guliani: https://sre.google/sre-book/managing-incidents/ . Public online chapter, copyright © 2017 Google; footnote 78 identifies an earlier *;login:* April 2015, vol. 40, no. 2 article. No web revision is stated.

**Documented human practice:** troubleshooting iterates hypotheses, telemetry/log inspection and controlled tests, with risks, confounding factors and sometimes only suggestive results. Clear investigation notes and documented changes support restoration of the pre-test setup. Incident management separates command, operational work, communication and planning; only the operations team should modify the system. A living incident-state document and explicit, acknowledged human handoff support coordination.

**Important limit:** service restoration and evidence preservation take priority; mitigation need not await complete root-cause analysis. Neither source publishes, endorses or evaluates this agent orchestration, deployment-approval guard, hypothetical outcomes or numeric retry limits. The modeled episode is restricted to an unknown-fault incident with no known safe immediate mitigation. A supported hypothesis is not proof of a unique root cause.

### Graph abstraction and proposed extensions

Five approved graphs remain: Incident command (`life`), Diagnosis, Evidence collection, Remediation and Verification. Incident command calls Diagnosis, Remediation and Verification; Diagnosis calls Evidence. True child returns resume the same suspended caller, with one shared scratch object. Refuted hypotheses, incomplete evidence, failed sandbox checks and unknown health loop locally. Unhealthy/inconclusive verification returns to parent rollback and renewed diagnosis, retaining global budgets.

Global diagnosis/repair/deployment caps are respectively **3/2/2**; evidence requests reset to a local **2** only on a new evidence invocation, and verification samples to **3** only on a new verification invocation. These bounds are illustrative, not Google policy. Missing telemetry or sandbox capability hands off; unsafe/exhausted work, denied authorization or explicit timeout escalates. Only root closure/handoff/escalation completes the whole workflow. No telemetry, sandbox, production change, real service recovery or incident-resolution result executes here.

Deployment-specific human authority is **proposed**. The native `approval` field defaults to `pending`; options are `pending`, `deployment 1 approved`, `deployment 2 approved`, `denied` and `timeout`. Supply only the option naming `records.deployments + 1`, at `life.authorize` after its current repair plan is prepared. Approval is consumed by the represented apply. After rollback, deployment-1 approval cannot authorize deployment 2; premature deployment-2 approval cannot authorize deployment 1. Pending/stale input spends no budgets. Handlers do not mutate live inputs; Back restores execution, not those inputs. Timeout is an explicit hypothetical human condition, not an automatic simulated clock.

### Preserved native scenarios

| ID | Scenario | Modeled terminal / decision boundary |
| --- | --- | --- |
| 1 | Safe success | Resolved after one native deployment approval |
| 2 | Refute then support | Local diagnosis revision, then resolved |
| 3 | Sandbox rework | Local repair revision, then resolved |
| 4 | Rollback → re-diagnose | Resolved only after two separately supplied deployment approvals |
| 5 | Denied telemetry | Blocked human handoff without apply |
| 6 | Human approval pending | WAIT at `life.authorize`; explicit current approval resumes the same incident |
| 7 | Human approval denied | Human escalation without apply |
| 8 | Never recovers | Two deployments/two rollbacks, then escalation; no third deployment |
| 9 | Evidence recollection | Local recollection, then resolved |
| 10 | Verification resampling | Local health resampling, then resolved without another deployment |

The producer verified the approved graph/scenario preservation and canonical handlers separately from its reference-browser proof. Those are upstream input provenance, not production verification; production browser checks drive the emitted route and its actual shared Simulator runtime.
