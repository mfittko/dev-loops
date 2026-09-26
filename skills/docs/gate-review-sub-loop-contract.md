# Checkpoint Review Chain Contract

Canonical owner for gate-review **execution shape** rules shared by the two dev-loop gate
boundaries: `draft_gate` and `pre_approval_gate`.

## Purpose

Both gates share one structured sub-loop: a build-once neutral context bundle,
independent-reviewer fan-out, fan-in synthesis, and iterative fix-then-retry.

### Execution model: build once, seed many (no fork)

<!-- rule: GATE-EXEC-BUILD-ONCE-SEED -->
`GATE-EXEC-BUILD-ONCE-SEED`: Each gate pass MUST build ONE neutral context bundle once
via a deterministic context-builder script and use reference seeding for every
independent, fresh-context reviewer: each reviewer receives a bounded work order whose
`requiredReads` manifest names every bulk evidence file of that bundle by path, sha256 and
byte count, and the reviewer reads those files itself in its own fresh context
(ADR 0086, `docs/decisions/0086-gate-fanout-reference-seeded-work-orders.md`, amends
ADR 0021). Reviewers MUST NOT fork from, or inherit, a parent agent's loaded context, and
the sub-loop MUST NOT depend on any fork primitive or the Workflow tool. Concretely:

1. `scripts/github/write-gate-context.mjs` builds the neutral head-bound bundle:
   full diff plus changed files' 1-hop import in/out-edges, with size guards. It writes
   the bulk evidence (PR and issue bodies, the filtered diff or a pointer to the filtered
   diff file, the changed-files summary, and the validation pointer) to
   `<gate>-<headSha>.briefing-evidence.txt` and records `requiredReads` on the context artifact.
2. Seed each independent fresh-context reviewer by reference: its work order carries the
   invariant prefix with the `requiredReads` manifest and every angle in its emitted unit
   ([Phase 2](#phase-2--fan-out-independent-reviewers-seeded-with-the-neutral-bundle)).
   The reviewer MUST read every required read in full before judgment. The context builder
   and the emitter MUST NOT clip or truncate correctness-critical evidence with an ellipsis
   to fit a prompt; a reference to the full artifact controls the size instead. A summary
   or excerpt MAY accompany a reference for navigation, but never replaces the full read.
   Widen only when a covered angle needs more; never inherit the conductor's conversation or opinions.
3. Fan-in consolidates the per-angle findings unchanged.

Build-once avoids repeated diff/adjacent-code discovery. Provider cache reuse is optional;
briefing layout and byte identity remain mandatory under `GATE-EXEC-BRIEFING-PREFIX` below.

This contract owns the **execution shape** of gate-review work. It does not own:
- which review angles a specific gate runs (that stays in the skill)
- the visible gate-review PR comment format (owned by [Gate Review Comment Contract](./gate-review-comment-contract.md), whose evidence is also required for a gate to be satisfied)
- the broader PR lifecycle sequencing (owned by the workflow skill and [PR Lifecycle Contract](./pr-lifecycle-contract.md))

The standalone `review` gate (`GATE_NAMES`, `scripts/github/_gate-names.mjs`) runs
Phases 1, 1.5, 2 and 3 with `--gate review`, then stops: no judge, fix, repeat,
auto-resolve, forbidden-action refusal or CI wait; any PR is eligible. Its recognized
header makes `@dev-loops/core/github/copilot-helpers` return non-evidence before the
lenient whole-body scan, with or without a findings-ledger marker. Its separate absence
from `GATE_CONFIG_KEY` means no draft/preApproval threshold, not the reason it cannot
satisfy lifecycle evidence. Follow the [Review skill](../review/SKILL.md).

## Separate chains per gate

<!-- rule: GATE-EXEC-SEPARATE-CHAINS -->
`GATE-EXEC-SEPARATE-CHAINS`: Each gate (`draft_gate`, `pre_approval_gate`) MUST run its
own independent review chain with its own review angles, its own disposition ledger, its
own fix cycle, and its own exit conditions. The chains are not interchangeable; each
gate's execution is a complete, self-contained sub-loop pass. The `draft_gate` fix cycle
covers only findings that block the draft→ready transition; the `pre_approval_gate` fix
cycle covers only findings that block final approval readiness. Angles and blocking
severities per gate are in [Gate-specific configuration](#gate-specific-configuration).

## Sub-loop phases

Both gates run the identical phases with their own review angles.

### Round owner: the gate coordinator

<!-- rule: GATE-EXEC-GATE-COORDINATOR -->
`GATE-EXEC-GATE-COORDINATOR`: Every `draft_gate` and `pre_approval_gate` review round MUST run
in a dedicated, fresh-context **gate coordinator** agent. This is the only sanctioned round
shape. The gate coordinator is the "gate-round capsule" of ADR 0081. It owns exactly one round
for one gate at one head and runs every in-round step: gate validation, the Phase 1 context,
Phase 1.2 carry-forward, the Phase 2 wave dispatch of `review` agents, the
Phase 3 fan-in and durable ledger write, the Phase 3.5 judge, and `judge-pass`. A light-mode
`inline_single_agent` round also runs inside the gate coordinator. Inside a round, "conductor" in
this contract means the gate coordinator. The dev-loop coordinator dispatches the gate
coordinator with the round's arguments, including the prior heads for this gate that it keeps in
run state, and awaits it with a blocking join (`END-TURN-AND-AWAIT-WAKE` in
[Anti-patterns](./anti-patterns.md)). The gate coordinator reads the prior rounds' ledgers,
judge verdicts, and prior-approvals record for this gate from their deterministic on-disk paths,
keyed by the prior heads the dev-loop coordinator passes in the dispatch arguments, so
`GATE-EXEC-JUDGE-NOT-FRESH` inputs and `judge-pass`'s `--prior-approvals` survive the fresh
context. The dev-loop coordinator never runs these steps in its own context. The gate
coordinator returns only the round's typed result: the verdict, the execution mode
(`fanout_fanin` or `inline_single_agent`, plus the inline reason and findings summary when the
round resolves to `inline_single_agent`), the severity counts, the fan-in output path, the
durable findings-log path, the act-list path, the spec-authority identity path, and the judge
summary. Reviewer and judge outputs stay in the gate coordinator's context and never propagate
to the dev-loop coordinator. The gate coordinator materializes and binds the round's evidence
through the context builder's `requiredReads` and emits compact work orders; it never relays bulk
evidence into a reviewer's task. The gate coordinator never posts the verdict comment, flips ready, pushes, or
merges; these reserved lifecycle writes stay with the dev-loop coordinator. On a head change, a
dispatch failure that `GATE-EXEC-DISPATCH-RETRY-BACKOFF` does not recover, or a fan-in failure,
the gate coordinator stops and returns a typed observation instead of choosing the next step. If
the Phase 3.5 judge rerun at the current head also fails, the gate coordinator stops and returns
a typed observation. The Phase 4 fixer and each Phase 5 repeat
are dispatched by the dev-loop coordinator, and each repeat round runs in a new gate coordinator.
If a harness cannot fan out at the gate coordinator's depth, the round fails closed with
`FANOUT_UNAVAILABLE_MESSAGE` ([below](#fail-closed-fan-out-unavailable--route-to-conductor))
and never degrades to inline review.

The standalone `review` gate is outside this rule's scope.

### Phase 1 — Preamble: context-builder

Before fanning out reviewers, run a preamble pass that produces review handoff context
in the PR's actual worktree/head — the same checkout the reviewers will run in — so the
gitignored, worktree-local `tmp/gate-context` bundle it writes is present for them:

- the context-builder runs in fresh context and emits a NEUTRAL artifact; that artifact (never the parent session's chat history or state) is what each downstream reviewer subagent is later seeded with. **Mandatory:** every gate-review subagent must run `dev-loops-run scripts/github/verify-fresh-review-context.mjs --scope <gate>-<angle> --context-path <path> --prefix-hash <sha256>` (or `--prefix-file <path>`) at startup and refuse to proceed on contamination or a missing gate-context artifact. Use a gate-prefixed `--scope <gate>-<angle>` (e.g. `draft-gate-coverage`) so each reviewer writes its own sentinel and attributes to its gate (see [Sentinel lifecycle](#sentinel-lifecycle)), `--context-path` to the artifact this phase writes below, and `--prefix-hash`/`--prefix-file` to record the invariant-briefing prefix hash enforced by `GATE-EXEC-BRIEFING-PREFIX`.
- **Worktree isolation is PROHIBITED for per-angle gate reviewers.** They are read-only
  (they never mutate files), so filesystem isolation buys nothing and actively breaks the
  "build once, seed many" contract: a fresh worktree is checked out from `main`, not the
  PR head, and has no access to the gitignored, worktree-local `tmp/gate-context` bundle
  this phase writes (#1135). Reviewers run in the PR's actual worktree/head — the same
  checkout the preamble ran in.
- Resolve the gate's angle set from `gates.<gate>.angles` (names/objects).
  Entries merge BY NAME across config layers: add/override/disable only the named
  entry, without copying the array. Duplicate names appear once and retain their
  mandatory/prunable status. `enabled: false` excludes an entry, including a
  mandatory one, and is a hard ceiling against later additions.
  - `dynamic.subtractive` defaults ON: retain relevant angles and record each
    dropped angle's rationale. Enabled `mandatory: true` entries always survive.
    When explicitly off, use the static pool unchanged. Without a diff, an
    ordinary caller also keeps the static pool; a floor-aware caller uses the
    mandatory floor plus justified lenses.
  - `gate:full` forces the full untriered set but retains grouped dispatch.
    To restore the full static per-angle fan-out, disable subtractive selection AND
    set `gates.fanout.mode: per-angle`; `gate:full` alone never selects per-angle dispatch.
  - `dynamic.additive` defaults OFF. When enabled, add recommended catalog angles
    absent from the configured pool, except disabled entries. The catalog is the
    explicit non-empty `gates.anglePool`, otherwise the union of built-in personas
    and configured draft/preApproval/spike angles. Record each addition as
    `action: "added"` with its triggering category or always-include reason.
- **Security-sensitive-seam trigger (`threat-model`).** When the change categories include
  `SECURITY_SENSITIVE_SEAM` — a **code** file's diff (config/doc/markdown lines that merely
  name a primitive are file-gated out) touches browser automation, `child_process`/shell
  execution, untrusted network fetch, or destructive filesystem / local-file-upload ops — the
  resolver selects the `threat-model` angle (recommended when configured; added from the pool in
  additive mode). It is never dropped for such a diff, regardless of change size. `threat-model` is
  an adversarial-security lens that returns an exhaustive trust-boundary checklist (input allowlists,
  navigation/origin confinement pre-launch **and** at runtime, resource/loop bounds, data-at-rest +
  cleanup on every fail-closed path, exported/entry-point self-validation, error/teardown safety,
  path-traversal/deserialization, shell-injection) rather than a spot-check — so a batched up-front
  pass surfaces the trust-boundary holes that would otherwise be drip-fed serially through Copilot
  rounds. `input-validation` is likewise part of the core `LOGIC_CHANGE` subset, not pool-only.
- the preamble produces one or more review handoff artifacts (branch, head SHA, PR/issue
  scope, acceptance criteria, touched files, validation posture). The resolved angle set
  and its rationale are written as a deterministic handoff artifact under
  `tmp/gate-context/<repo-slug>/pr-<N>/<gate>-<headSha>.json` so the fan-out phase
  consumes a stable, auditable briefing per head SHA.
- the preamble ALSO builds the deterministic **neutral context bundle** ONCE: the full
  diff (`scope.diffPath`) plus an adjacent-code bundle (`adjacentCode`) containing each
  changed file and its 1-hop import in/out-edges (callers/callees/imports), with size
  guards (skip lockfiles/generated/binary/minified; cap per-file bytes; truncate the
  long tail) recorded in a `stripped`/`truncated`/`missing` manifest for observability.
  This is the build-once, work-deduped seed every reviewer's work order references; no
  reviewer re-derives the diff + adjacent code from scratch.
  - **`scope.diffSource` posture (CLI `--base`).** `write-gate-context.mjs` records this
    full bundle only when it has a resolvable diff source. Pass `--base <ref>` and the CLI
    captures the diff itself (`git diff <ref>...HEAD`, run with color/pager/external-diff
    config isolated so the persisted bytes are environment-independent) and stamps
    `scope.diffSource: "base"` — the full build-once bundle (`scope.diffPath` +
    `scope.changedFiles` + `adjacentCode`). Without `--base`, the CLI does NOT silently
    emit a full-looking bundle: it warns and stamps `scope.diffSource: "none"` — an
    explicit **thin briefing** (`scope.diffPath: null`, `scope.changedFiles: []`, no
    `adjacentCode`) that reviewers detect and fall back from (re-derive via `git diff`). A
    `--base` that fails to resolve (its `git diff --name-status` fails) fails closed
    (non-zero exit, no artifact) rather than degrading to a thin briefing. Programmatic
    `buildGateContext({ diff })` callers are unaffected and omit `scope.diffSource` entirely.
  - **Partial `"base"` (best-effort full-diff).** `scope.diffSource: "base"` can co-occur
    with `scope.diffPath: null`: the required `git diff --name-status` succeeded (so
    `scope.changedFiles` + `adjacentCode` are present — it IS a base-derived bundle) but the
    best-effort FULL-diff capture degraded (e.g. output exceeded the buffer, a render error),
    so no persisted `.diff` was written. Reviewers MUST therefore key their diff-fallback on
    `scope.diffPath` (null → re-derive via `git diff`), NOT on `scope.diffSource`:
    `diffSource` distinguishes a base-derived bundle (`"base"`) from a thin briefing
    (`"none"`), while `diffPath` independently signals whether the persisted full diff is
    available.
  - **Spec resolution (`scope.acceptanceCriteriaSource`, CLI only).**
    With `--pr-body`/`--issue-body`/`--acceptance-criteria` omitted,
    `write-gate-context.mjs` resolves the live PR body, closing references and ALL
    closed issue bodies. Any failed PR/issue read fails closed with a named error
    and no artifact; failed resolution never means absent description/criteria.
    Explicit `--acceptance-criteria` suppresses automatic issue-body fetching;
    additionally pass `--issue-body` to retain issue text in the prefix.
    `--prefix-file` skips live resolution entirely because those fields cannot
    alter caller-supplied prefix bytes.

    | Source value | Meaning |
    | --- | --- |
    | `provided` | Explicit criteria, whether or not an issue body was supplied. |
    | `linked-issue` | At least one resolved issue contains the full AC checklist + DoD checklist + explicit Non-goals matrix, or a linked refinement doc. |
    | `linked-issue-unrefined` | Issues resolved, but none contains that full refinement matrix. |
    | `none` | The PR closes no issue. |

    Programmatic `buildGateContext`/`writeGateContext` callers omit this field:
    null criteria without it means unresolved, not proven absent/unrefined.
    Umbrella issues appear together under `## Linked issue <ref1>, <ref2>`,
    each with its own `### <ref>`. GitHub `closingIssuesReferences` resolve in
    each reference's OWN repository; the fallback `Closes #N` parser runs only
    when GitHub reports none and supports same-repo references only.

    A conductor MUST NOT rebuild context while reviewers for that head run.
    Live body edits change the stable prefix: the builder refuses a changed-byte
    same-head rebuild while that gate+head has live sentinels (exit 1, no writes),
    naming their files and recorded hash. The same refusal covers a
    same-head rebuild that would rewrite a prior-dispositions, known-findings or
    scoped-variant file, even when the prefix bytes are unchanged. Sentinel-scan errors other than missing
    tmp/ also refuse; only an unreadable EXISTING prefix remains advisory because
    a difference cannot be proven. Retired rounds without live sentinels are
    unaffected. Follow `GATE-EXEC-ROUND-RETIREMENT`: retire THEN rebuild, never
    use retirement as permission to rebuild mid-flight.
- reference the pi-subagents `parallel context-build` technique when applicable:
  run parallel `context-builder` agents from fresh context with distinct output paths
  (e.g. `context-build/request-and-scope.md`, `context-build/codebase-and-patterns.md`,
  `context-build/validation-and-risks.md`) and synthesize the outputs into the review
  handoff artifacts

#### Request-plan artifact and harness capability

`write-gate-context.mjs` writes two siblings beside the briefing prefix: deterministic `<gate>-<headSha>.dispatch-plan.json` and timestamped `<gate>-<headSha>.briefing-volatile.txt`.

The plan schema, grouping/fingerprinting rules and four-dimensional capability vocabulary (including opaque/unavailable defaults) remain owned by `@dev-loops/core/loop/review-dispatch-plan`: `buildReviewDispatchPlan`, `buildAngleRequestGroups`, `normalizeHarnessCapabilities` and `fingerprintRequestPrefix`. A fingerprint proves observable request-SHAPE identity, never a provider cache hit.

The writer owns pending-angle selection, concrete model resolution, prefix hashing, capability-derived TTL defaults and write ordering. It intersects the trimmed angle universe with `fanoutDispatch.pendingGroups`, excluding completed/carried angles, and resolves each model with `resolveRoleModel(config, { role: angle, harness, kind: "angle" })`, including config overrides and per-angle/built-in review tiers—not the bare override returned by `resolveReviewerRole(...).model`.

Interpret the emitted plan within these shipped limits:

- Entry points currently resolve the `claude` harness. The writer accepts `options.harness`, but neither a CLI `--harness` flag nor `buildGateContext`'s whitelist forwards another harness. Claude-resolved groups are not evidence of Pi dispatch models: Pi's built-in tiers inherit unless configured. Without config, the reserved `"inherit"` grouping records only that no config was consulted, not verified dispatch grouping.
- `sharedPrefixHash` is the `sha256:`-prefixed hash of actual same-call prefix bytes; the writer's returned/sentinel `prefixHash` remains bare hex.
- Production grouping supplies models, that hash, `REQUEST_PLAN_BLOCK_BOUNDARIES` and TTL intent. It does not supply `toolDefinitions`, `instructions` or `settings`; their empty defaults mean shipped fingerprints do not observe changes to those inputs.
- TTL defaults are `"5m"` for caller-selectable `"5m_1h"` capability and `"harness_managed"` for `"fixed"`/`"opaque"`; shipped Claude defaults to `"fixed"`.
- Every group retains `cacheBoundary: "after_shared_prefix"`. Under `GATE-EXEC-BRIEFING-PREFIX`, scoped companions follow the full shared prefix; they never replace it.

The physically separate volatile tail follows that boundary. Put only values the stable renderer does not consume there, except its repeated identifying `gate`/`head` header. `validationPosture` belongs there (the evidence file receives only `validationResultsPath`) and rejects embedded newlines; `loggedAt` is a genuine per-write timestamp. `acceptanceCriteria` is never volatile: it feeds the stable linked-issue heading when issue body/sections exist and is recorded in `scope.acceptanceCriteria`. Volatile-only changes leave prefix bytes and hash unchanged.

**Write ordering.** Both builder and CLI prepare the full diff without persisting it. The shared writer renders the evidence file and scoped briefings in memory, refuses a rebuild with live sentinels that would change the prefix or any hash-bound read outside it (prior-dispositions, known-findings, scoped variants), and validates the plan/volatile tail before overwriting any referenced file. Refusal preserves the prior set's bytes. The prefix binds the evidence file and the full diff by sha256, so a change to either changes the prefix. Before changing a prefix, evidence file, scoped briefing or full diff, the writer MUST invalidate the previous JSON marker. It then persists those stable files, volatile tail and dispatch plan, writing the JSON completion marker LAST. Successful reruns with unchanged stable bytes retain the marker in place. Optional diff/variant write failures retain their existing fallback only after invalidation: rebuild pointers/hash/plan without a failed diff, or downgrade failed variants to the full briefing. A failed required write MUST remove the marker even when prefix bytes are unchanged; landed siblings and round history remain for diagnosis. If cleanup also fails, report both errors and MUST NOT report success. `readGateContext`, dispatch emission and reviewer `--context-path` checks use the marker; after a failed write, repair the failure and rebuild the complete set before dispatching.

A request plan proves request-shape identity only. It never proves a provider cache write or read.

### First-wave release

<!-- rule: GATE-EXEC-FIRST-WAVE-RELEASE -->
`GATE-EXEC-FIRST-WAVE-RELEASE`: After Phase 1 builds and validates the round context and the emitter writes the bounded work orders, the gate coordinator MUST release the first reviewer wave immediately, bounded only by `resolveFanoutEffectiveConcurrency` (Phase 2). No primer spawn, lead reviewer, or other cache-warming step precedes that wave. Reviewer 1 is never required to complete, or to emit output, before the other slots of the first wave are released. Correctness, successful dispatch, fan-in, and the gate verdict MUST NOT depend on a provider cache hit or on any priming evidence; the shared prefix stays compact and is never inflated for cache economics.

Cache priming is an optional, non-semantic execution optimization. A harness or execution adapter MAY prime internally only when its capability and measured economics justify it. Priming MUST NOT change review semantics or evidence, reduce reviewer independence, serialize a completion-only lead reviewer before the wave, or become a fan-in or verdict precondition. Where cache telemetry is exposed, a round MAY record creation and read events at `<gate>-<headSha>.cache-telemetry.json` (`cacheTelemetryPath` / `buildCacheTelemetryEvidence` / `writeCacheTelemetryEvidence` from `@dev-loops/core/loop/cache-telemetry-evidence`); `GATE-EXEC-CACHE-TELEMETRY` validates a recorded artifact. Opaque or unavailable telemetry records `cacheReuseVerified: false` with a reason: it is never described as verified reuse, and missing telemetry never fails the gate.

These workflows use Pi/Claude Code agent harnesses, not a raw-API path: the conductor cannot set `prompt_cache_key` or explicit breakpoints, and the shipped agent-dispatch surfaces expose no provider usage/cache-read telemetry. Do not add a verification pass or invent a cache pin. The prefix-hash, required-read hash, sentinel, same-head rebuild/retirement, and fan-in provenance checks stay load-bearing and unchanged.

<!-- rule: GATE-EXEC-VALIDATION-ARTIFACT -->
`GATE-EXEC-VALIDATION-ARTIFACT`: The preamble MUST run the round's validation set exactly
once, before any reviewer is dispatched, via `run-gate-validation.mjs`, and MUST persist
the result as `<gate>-<headSha>.validation.json` beside the gate-context artifact. When
that artifact exists, the briefing prefix MUST point every reviewer at it
(`write-gate-context.mjs --validation-results <path>`), and a reviewer MUST consume it
rather than executing any suite it records. A reviewer that finds the artifact absent,
unreadable, or stamped with a different head SHA MUST report a gate-evidence finding; it
MUST NOT silently run the suite itself and MUST NOT treat the gap as clean.

### Phase 2 — Fan-out: independent reviewers seeded with the neutral bundle

<!-- rule: GATE-EXEC-REVIEWER-BUDGET-PREFLIGHT -->
**Reviewer-budget preflight.** Before fan-out, read the harness's exposed remaining reviewer budget and pass it as `write-gate-context.mjs --available-reviewers <n>`. Read `artifact.fanout.preflight`, derived by `reviewerBudgetPreflight` (`@dev-loops/core/loop/gate-fanin`). It compares the budget with required dispatch units (fresh angles plus re-verifications, grouped where applicable), not the raw angle count.

```
{ ok, dispatch, requiredReviewers, availableReviewers, shortfall, reason, verdict, executionMode, completedAngles, carriedAngles, pendingGroups, skippedGroups }
```

| Result | Required action |
| --- | --- |
| `dispatch: true` | Proceed with wave-by-wave fan-out. An unexposed budget (`availableReviewers: null`) also proceeds: only a proven shortfall blocks. |
| `dispatch: false`, `reason: "budget_shortfall"` | MUST spawn zero reviewers. The context records the head-bound plan and exact `shortfall`; preserve completed artifacts and resume when budget becomes available. |

To resume at the same head, rerun `write-gate-context.mjs` with the refreshed budget. Its reviews-directory scan supplies `completedAngles`: angles with CLEAN findings artifacts stamped for that head. Prior-head artifacts require the separate [fail-closed carry-forward seam](#angle-carry-forward-fail-closed); pass only its proven carried names through `--carried-angles <json>`. That seam permits eligible `clean` or `findings_present` verdicts and rejects equal `--prev-head` / `--head-sha`; same-head scanning does not use it.

`preflight.carriedAngles` is always emitted, including when empty. The preflight excludes a unit from `requiredReviewers` and `pendingGroups` only when ALL its angles are complete or carried. Dispatch only pending groups through the emitter below; never redispatch a completed-or-carried group. Completed artifacts remain valid for their own head.

**No gate exemption.** `preflight.verdict` and `preflight.executionMode` remain `null`: shortfall is resumable state, never a clean verdict or permission to use `inline_single_agent`. `buildPreMergeGateCheck` / `evaluateInlineFanoutMode` retain the fail-closed merge requirements for a clean current-head marker and qualified `fanout_fanin` execution.

Resolve grouping through `resolveFanoutGroups(config, gate, resolvedAngles, { fullLabel })` (`@dev-loops/core/config`), then dispatch through `GATE-EXEC-FANOUT-DISPATCH-EMIT` below. Do not treat the context's unsplit groups as the final emitted units.

<!-- rule: GATE-EXEC-FANOUT-CAPACITY -->
`GATE-EXEC-FANOUT-CAPACITY`: Every planned round MUST dispatch in exactly one wave. `write-gate-context.mjs` (`resolveFanoutDispatch`) derives the base units: the RESOLVED units after the emitter's cap-split at `REVIEWER_UNIT_MAX_ANGLES` (5) — the round's resolved-angle grouping, deliberately NOT the completed/carried-filtered pending set, so wave 1 and every same-head resume derive identical units and the recorded membership still admits the wave's reviewers. When the base units exceed the effective `maxConcurrent`, it packs whole base units first-fit decreasing by angle count, ties broken by unit name, into at most effective `maxConcurrent` units of at most 5 angles. A merged unit's name joins its member unit names in sorted order with `+`, and the emitter records that name as the provenance `group`. Packing never splits a base unit and never runs when the count already fits, so a restored `holistic` singleton stays alone in a round that fits. The packed list is recorded in the context artifact's `fanout.groups` and `pendingGroups`, which the emitter consumes. When the full resolved grouping cannot pack, the decision is keyed on the DISPATCHABLE set — the resolved units minus every group whose angles are ALL carried forward (a set fixed for the whole round) — and that dispatchable plan is emitted when it fits one wave, so a carry-forward re-gate whose fresh plan fits is never blocked. The writer MUST refuse with exit 1 before writing any artifact only when the dispatchable plan itself cannot fit, naming the resolved angle count, the fresh (non-carried) count, the capacity and the remedies: raise `gates.fanout.maxConcurrent`, disable angles, or rely on dynamic pruning. It never plans a second wave. `gates.fanout.sequential: true` and `mode: per-angle` are explicit opt-outs that neither pack nor refuse. The standalone `review` gate is outside this rule: its full-PR angle set exceeds single-wave capacity, so it keeps its multi-wave plan.

| Input | Resolver behavior |
| --- | --- |
| `gates.fanout.mode` unset or `grouped` (default) | Match configured `gates.fanout.groups` first; chunk remaining angles by `gates.fanout.maxAnglesPerGroup` (default 5). |
| `mode: per-angle` | Bypass configured groups; one singleton per angle. `maxAnglesPerGroup: 1` is equivalent only when no configured multi-angle group matches. |
| `gate:full` | Force the full angle set upstream (`gate_full_label`), while retaining grouped dispatch; it does not imply per-angle mode. |

`gates.fanout.groups` is a global reviewer-identity table shared across gates. A group participates only when the gate resolves one of its angles. Grouping changes reviewer allocation, never the resolved angle set, per-angle evidence, or provenance requirement. The emitter shares every multi-angle resolved unit, whether configured or auto-chunked, and keeps only genuinely single-angle units as singletons; its units are the dispatch authority.

Keep reviewer groups separate from `requestGroups`: the latter batch models/request fingerprints for caching, not reviewer identity. Validate provenance against the recorded dispatch units (`fanoutReviewerPairingError`), never against model/cache groups.

The gate coordinator dispatches one independent, fresh-context `review` agent per emitted unit via the plain Agent tool — releasing the wave's units together (under Pi: ONE call per wave, the wave rule below), never N separate blocking calls — each given its unit's bounded work order, which references the neutral evidence and carries its angle prompts. Never inherit the gate coordinator's, the dev-loop coordinator's, or a sibling reviewer's context. Follow the [review agent's scoped angle-review mode](../../agents/review.md).

Wave the emitted units under the emitter's `maxConcurrent` (`resolveFanoutEffectiveConcurrency`) in ONE call per wave — under Pi a single `subagent({ workflowScriptPath })` call whose script body returns ONE `runs.all([...])` with its own unique `key` per unit (this shape needs pi-subagents ≥0.57; `tasks: [...]` was removed in 0.41.0, and the repo's `Dockerfile` `PI_SUBAGENTS_VERSION` pin is below that floor and must be raised for the shape to run in the declared container) — then join that wave before releasing the next. Never issue N separate blocking per-unit calls for one wave: that is the shape Pi's foreground guard rejects, and it silently serializes the round. The configured cross-harness default is 5, so a full shipped round (capacity 5 x 5 = 25 angles) packs into one wave (`GATE-EXEC-FANOUT-CAPACITY`). This repo also configures 5, independent of `queue.maxParallel: 3`, so its combined peak is 3 runners x 5 = 15 concurrent reviewer units. It relies on `GATE-EXEC-DISPATCH-RETRY-BACKOFF` for transient 429s; if 429s rise, lower `queue.maxParallel` first and keep `maxConcurrent` at 5 so one round stays one wave. `gates.fanout.sequential: true` resolves to 1, so each reviewer completes and writes evidence before the next starts. Under the Claude harness the effective value is additionally capped at 5; Pi/unknown harnesses retain the configured value. These bounds never collapse independent review into inline review.

If a dispatch still receives 429, follow `GATE-EXEC-DISPATCH-RETRY-BACKOFF` below: retry the same unit under the helper's policy, then halve the batch with `backoffMaxConcurrent` and recompute waves before foreground one-at-a-time fallback. Record degradation in gate evidence/provenance. Never launch all units and rely on retries to impose the bound.

<!-- rule: GATE-EXEC-COLLECTABLE-DISPATCH -->
`GATE-EXEC-COLLECTABLE-DISPATCH`: Every fan-out reviewer MUST be dispatched as a
**COLLECTABLE** run, never detached and unobservable. The conductor MUST await a
joinable/foreground run or its deterministic per-angle artifacts at
`tmp/gate-reviews/<repo-slug>/pr-<N>/<gate>-<headSha>/<angle>.json`.
A run that cannot be joined at fan-in is failed. A reviewer killed mid-review MUST be
observed as failed and re-dispatched (or its wave retried at reduced concurrency),
never counted as evidence. Apply the emitter's concurrency bound above wave by wave,
awaiting a free slot; every budget-bounded unit writes its per-angle artifacts before fan-in.

`consolidate-fanin --expected-dispatch-units <n>` fails closed on missing expected
evidence. If genuine fan-out still cannot produce evidence within budget, STOP for
an operator's per-PR decision; never automatically degrade to inline. Inline remains
limited to the light-mode `scopeUnderThreshold` carve-out or explicit per-PR operator decision.
Each reviewer:

- starts in fresh context: run the mandatory `verify-fresh-review-context.mjs` invocation exactly as Phase 1 specifies. In the fan-out, `--scope` additionally keeps parallel reviewers in the same working directory from tripping false contamination on each other's sentinels, and `--context-path` (the Phase 1 artifact) fails a reviewer in the wrong/isolated checkout closed. A grouped reviewer runs this ONCE for the whole group, passing the emitted unit's `scope` verbatim as `--scope` — exactly as its prompt states, never composed from the unit name — not once per angle it covers. The sentinel is keyed per review ROUND by the current head SHA, so a retry at a new head naturally gets a fresh sentinel — see [Sentinel lifecycle](#sentinel-lifecycle). Here "fresh" means the reviewer's context is the neutral builder artifact + its angle(s), and explicitly NOT the main agent's conversation/state or a prior reviewer session's state: the injected neutral bundle is the intended seed (allowed), while main-agent / cross-session state bleed fails closed.
- is composed via the sanctioned composer (`GATE-EXEC-BRIEFING-PREFIX`'s "The composer" paragraph): the same step that runs `verify-fresh-review-context.mjs` (above) is `scripts/github/emit-fanout-dispatch.mjs --repo <repo> --pr <n> --gate <gate> --head-sha <sha>`, which for each dispatch unit writes that unit's angle-suffix and drives the composer core (`composeAndRecordReviewerPrompt`) internally — inlining this round's invariant-prefix bytes as the leading bytes, appending the volatile tail and the angle suffix, writing the composed prompt, and recording its dispatch-prompt layout ATOMICALLY (no separate `record-dispatch-prompt-layout.mjs` call needed on this path — the composer core already made it). The orchestrator then delivers each emitted unit's `promptPath` bytes to its reviewer per the "Per-harness delivery" paragraph below. Hand-composing a prompt and calling `record-dispatch-prompt-layout.mjs` directly against it remains possible as the underlying primitive, but is no longer the sanctioned fan-out path; the composer's own CLI (`compose-reviewer-prompt.mjs`) refuses every direct fan-out invocation (it never writes the keyed emit-plan.json fan-in requires) and names this emitter instead.
- reads the neutral evidence its work order references (`requiredReads`: the evidence file with the diff, or for a scoped unit its `scoped-evidence` variant in place of that file, and the filtered diff file as the required `diff` read in both modes, for a scoped unit too; the unfiltered `.diff` is the optional `raw-diff` widening read) in full as its base. It reads the `prior-dispositions` list and the `known-findings` list in full when the volatile tail names them. It queries the context artifact's `.adjacentCode` (an optional navigation aid, never a required full read) and the optional validation record field by field with `jq`, and widens (loads more files) only when a covered angle genuinely needs more — it does not re-derive the whole diff/adjacent-code graph. When it widens, it records in the findings artifact's optional `contextWidened` field ONLY the files that actually moved its judgment, never every file it opened. Absence of `contextWidened` (or an empty one) means "not consulted" — never "consulted and clean"; carry-forward and audit logic MUST NOT infer clean-ness from that omission.
- is scoped to exactly one review angle (one angle per unit under `mode: per-angle`, which bypasses configured groups; every angle in its resolved group (grouped mode, the default — including `gate:full`, which dispatches grouped) — each angle keeps its own prompt, all appended after the one shared invariant prefix (`GATE-EXEC-BRIEFING-PREFIX`)
- is **read-only**: inspects the diff and returns findings via output artifacts only; never edits files
- runs in the PR's actual worktree/head — **never an isolated worktree** (the Phase 1
  prohibition; `verify-fresh-review-context.mjs --context-path` enforces it mechanically —
  fails closed if the seeded artifact isn't present at the reviewer's cwd).
- produces a focused findings artifact PER ANGLE it covers, each with its own verdict (clean/findings_present) and file references, stamped per the head-stamp rule below — a grouped reviewer writes as many artifacts, at the existing per-angle paths, as it has angles, never one merged artifact for the group
- completion is detected via the harness completion notification, or the reviewer's findings artifact(s) at their deterministic output paths; the orchestrator awaits fan-in on those paths and joins via the sanctioned fan-in CLI `dev-loops gate consolidate-fanin` (backed by `consolidateFanin`; Phase 3). The forbidden fan-in wait improvisations (transcript-tailing, `node -e`/`python3` tool-JSON parsing, `sleep`-poll loops) and this sanctioned wait are owned by `ANTIPATTERN-FANIN-WAIT` in [anti-patterns](./anti-patterns.md).

<!-- rule: GATE-EXEC-FANOUT-DISPATCH-KEY -->
`GATE-EXEC-FANOUT-DISPATCH-KEY`: Every `runs.all` / batch reviewer dispatch MUST carry a unique
non-empty `key` on each item (angle/group slug). Missing or blank keys cause Pi's
`runs.all` validation error `invalid key`. On ANY dispatch failure, the conductor MUST
stop and report, never silently degrade a `gates.requireFanoutEvidence` gate to
`inline_single_agent`. Posting and merge share `evaluateInlineFanoutMode`'s fail-closed
qualification; only the light-mode `scopeUnderThreshold` carve-out or an explicit
operator decision per PR permits inline.

**Grouped dispatch (default).** Use the resolver and emitter above. Each emitted unit is one concurrent reviewer, while artifacts remain per-angle. Record the emitted group name on every fresh provenance entry that shares that reviewer; [Fan-out provenance](#fan-out-provenance-closing-the-self-produced-artifact-loophole) owns pairing and `countFreshDispatchUnits` owns the distinct-reviewer floor.
<!-- rule: GATE-EXEC-NO-CWD-DEPENDENCE -->
`GATE-EXEC-NO-CWD-DEPENDENCE`: A reviewer MUST NOT depend on the shell's working directory — each command may start in the primary checkout, not the worktree under review, so a bare `git branch`/`git log`/`git diff` can read the wrong tree and produce confident false findings. Run the mandatory sentinel invocation as ONE compound command that enters the worktree first (`cd <worktree> && dev-loops-run scripts/github/verify-fresh-review-context.mjs ...`) with its cwd-relative `--context-path` exactly as briefed — the locality guard depends on that form, and the compound form is the sanctioned remedy for the resetting cwd. After it passes, address the tree explicitly with the explicit-root idiom owned by `WORKTREE-DEFAULT-USE` in [worktree-guidance](./worktree-guidance.md#default-rule-use-a-worktree-for-mutating-local-work) (`git -C <repoRoot>`, absolute-path reads), where `<repoRoot>` is the briefing prefix's `worktree:` line, echoed back as `repoRoot` in `verify-fresh-review-context.mjs`'s fresh output (the directory the sentinel ran in, worktree-local when the locality guard passed).

<!-- rule: GATE-EXEC-SOURCE-READ-WORKTREE -->
`GATE-EXEC-SOURCE-READ-WORKTREE`: A reviewer citing a skill/doc/source file in a finding MUST read it from the WORKTREE SOURCE under review, not from an installed skill layout (`.pi/skills/`, `~/.pi/agent/`). Installed copies lag a PR that modifies those source files, so reading them produces false high-severity findings against text the PR already fixed (#1603). Resolve skill/doc paths (e.g. `skills/<name>/SKILL.md`, `skills/docs/...`, `docs/...`) as RELATIVE paths from the worktree cwd named on the briefing prefix's `worktree:` line. Before reporting a finding that quotes a skill/doc line, verify the cited text matches `git show HEAD:<path>` (the worktree source at the reviewed head); a finding whose cited text does not appear in `git show HEAD:<path>` is a false positive against a stale installed copy and MUST NOT be reported. This governs SOURCE FILES reviewed as content, not HELPER SCRIPT paths invoked as tooling — those still resolve from the installed skill layout per `ASSET-PATH-SOURCE-NO-REPO-LOCAL`. The briefing prefix carries this invariant as a fixed `## Reviewer source-read invariant` section (below) so every reviewer of a round is seeded with it byte-identically.


<!-- rule: GATE-EXEC-ARTIFACT-HEAD-STAMP -->
`GATE-EXEC-ARTIFACT-HEAD-STAMP`: A per-angle findings artifact MUST carry a `headSha` field stamped with the reviewed head from the briefing, and Phase 3's `consolidate-fanin --head-sha <sha>` MUST fail closed, naming the angle, when an artifact's stamp differs from the round's head or is missing/malformed — unknown provenance is a failure, not a bypass. Two exemptions exist: an angle declared carried forward via `--carried-angles`/`--carry-forward-plan` (exact declared name, matched case-insensitively), which keeps the existing carry-forward behavior and leaves the ledger's `carriedFromHead` as the single provenance field; and a `verdict: "blocked"` artifact, whose refusal shape carries no stamp and whose failure is owned by the blocked-verdict fail-closed path. This is what makes a stale artifact staged out of an earlier round distinguishable from a fresh verdict at the reviewed head.

#### Briefing composition: invariant prefix first

<!-- rule: GATE-EXEC-BRIEFING-PREFIX -->
`GATE-EXEC-BRIEFING-PREFIX`: Every per-angle reviewer briefing MUST be composed as an
**invariant block** followed by the **angle-specific prompt(s)** of its dispatch unit (one
prompt per angle under `mode: per-angle` (bypasses configured groups: one singleton unit per angle); every angle prompt under
grouped mode, the default — including `gate:full`, which dispatches grouped as of ADR 0048), in that order —
never angle-first. The invariant block MUST be byte-identical across every reviewer of the
same gate pass and MUST carry, at minimum: the repo, PR number, head SHA, and worktree path; the
`write-gate-context.mjs` gate-context artifact path (`GATE-EXEC-BUILD-ONCE-SEED`); the
mandatory `verify-fresh-review-context.mjs` instruction above; and the **findings write-path
invariant** — the WORKTREE-ABSOLUTE per-angle findings directory (`<worktree>/tmp/gate-reviews/<repo-slug>/pr-<N>/<gate>-<headSha>/`)
a reviewer MUST write into (`GATE-EXEC-FINDINGS-WRITE-PATH`, #1978). A reviewer's shell cwd is
not trustworthy across its commands (each may start in the primary checkout, not the worktree),
so a cwd-relative `tmp/...` write can land in the primary checkout's tmp/ where fan-in never
looks — surfacing only as a late "missing evidence" failure. Pinning the absolute per-angle dir
in the byte-identical prefix prevents that at dispatch; `consolidate-fanin.mjs` additionally
detects a findings artifact stranded in the primary checkout and names it in the missing-evidence
diagnostic rather than failing opaque. The consolidated findings-log **ledger** is the exception:
it is anchored at the MAIN worktree automatically (#2315 — so the merge, running from the main
checkout, can read it and it survives linked-worktree pruning), so the `write-gate-findings-log.mjs`
ledger writer MUST NOT be `--tmp-root`-pinned to the linked worktree (pinning it loses the ledger
on prune and refuses the merge for missing provenance). Angle identity MUST appear
ONLY in the suffix (the angle-specific prompt, e.g.
`COPILOT-FOLLOWUP-ADVERSARIAL-BRIEFING`'s persona prompt) and the reviewer's `--scope` flag
— never inside the invariant block, or the byte-identity requirement is violated by
construction and the shared-prefix prompt-cache opportunity is destroyed byte one.

**Cache alignment.** Prefix-first, angle-last is the cache-alignment rule: a provider prompt
cache matches on a shared PREFIX of the request, so the orchestrator MUST place the
byte-identical block at the START of every reviewer prompt and the angle-specific suffix
LAST, never interleaved or reordered per reviewer. This governs prompt LAYOUT only — the
byte-identity/hash machinery above (`--prefix-hash`/`--prefix-file`,
`verify-briefing-prefixes.mjs`) is unchanged, and the rendered
`<gate>-<headSha>.briefing-prefix.txt` file remains the recorded proof of what was
byte-identical. Under a harness where
the orchestrator seeds each reviewer with a pointer to that file rather than inlining its
bytes into the prompt (`prefixMode: "file"` below, or any other pointer-based seeding), the
pointer LINE ITSELF — not just the file it names — MUST be byte-identical across every
reviewer of the round; a pointer that varies per reviewer (e.g. embeds the angle name or a
per-reviewer path) defeats prefix matching exactly as an inlined angle-first prefix would,
even though the referenced file's bytes are still shared. This pointer-based PREFIX-recording
mode is distinct from the sanctioned fan-out dispatch: the emitted UNIT that
`GATE-EXEC-FANOUT-DISPATCH-EMIT`'s composer produces ALWAYS inlines the prefix (never a
pointer line), and the "Emitted-unit binding" fan-in check below rejects a pointer-seeded
emitted prompt as not inline-aligned. Pointer-based seeding governs how the PREFIX bytes are
recorded for hash byte-identity; it is not a compliant emitted-prompt LAYOUT for a dispatched
reviewer. Reference seeding of the bulk evidence through `requiredReads`
(`GATE-EXEC-BUILD-ONCE-SEED`) is compliant: the compact invariant prefix stays inline, and only
the evidence it binds by sha256 lives in referenced files.

**The composer.** `scripts/github/compose-reviewer-prompt.mjs` exports the
INTERNAL compose-and-record core, `composeAndRecordReviewerPrompt` — it is NOT
a conductor-invocable fan-out CLI (its own CLI refuses every direct invocation
and names `emit-fanout-dispatch.mjs`, the sanctioned caller, instead; issue
#2166). Given `repo`/`pr`/`gate`/`headSha`/`scope` and `angleSuffixFile`, the
core reads the round's `.briefing-prefix.txt` and `.briefing-volatile.txt`,
then writes prefix + volatile + supplied angle suffix in that order
(`composeReviewerPromptText`). The same atomic call records the layout
through `recordDispatchPromptLayout`; no separate recording step is needed. It
returns the byte count of each section (`sectionBytes`: prefix, volatile, suffix).
It places supplied angle text verbatim, never generates its content. The
emitter below is the ONE caller that drives this core, once per dispatch
unit, supplying the sanctioned per-unit suffix. Hand composition/direct
`record-dispatch-prompt-layout.mjs` remain underlying primitives, not the fan-out path.

<!-- rule: GATE-EXEC-FANOUT-DISPATCH-EMIT -->
`GATE-EXEC-FANOUT-DISPATCH-EMIT` (issue #2092): The composer produces ONE reviewer prompt;
turning the whole round's gate-context bundle INTO those per-unit prompts is itself a single
sanctioned step — `scripts/github/emit-fanout-dispatch.mjs` — NOT a composition the conductor
re-derives per round. Given a gate + head whose `write-gate-context.mjs` bundle is already on
disk, the emitter reads the artifact's fan-out dispatch plan (`artifact.fanout.groups`, or
`artifact.fanout.pendingGroups` under `--pending`) and, for EACH resolved dispatch unit,
writes the unit's angle-suffix and drives the composer core above (`composeAndRecordReviewerPrompt`,
the shared atomic compose-and-record core). It emits one
`{ scope, angles, group, promptPath, promptBytes, sectionBytes, workOrder }`
per DISPATCH unit plus a `maxConcurrent` field. Each unit's prompt is a bounded work order and
uses reference seeding: the `workOrder` carries the target, the round identity (gate, head,
prefix sha256), the merged-config sha256 (informational only; nothing verifies it), the assigned angles with each angle's resolved persona
and prompt (`angleInstructions`), the `requiredReads` manifest (the context artifact's shared
reads; when all of the unit's angles share one non-`full` scope, that scope's hashed
`scoped-evidence` entry, copied from the context artifact, replaces the shared `evidence` read),
the per-angle output refs and the execution rules. Bulk evidence stays in the referenced
files. The emitter refuses (exit 1) a work order over `REVIEWER_WORK_ORDER_MAX_BYTES` (30 KB),
naming the unit, its angles and the byte count, or one carrying an inline `diff --git` line
(a heuristic guard). The
conductor then dispatches those emitted units in one wave (under Pi: ONE call per wave; one fresh-context `review`
subagent per unit, whose task is that unit's work order, its `promptPath` bytes relayed unchanged), records each unit's
`group` on Phase 3's `--provenance`
(null for an unsplit single-angle resolved unit; the original resolved unit's own name —
configured or auto-chunk — for every split sub-unit, including a one-angle tail, and for an
unsplit shared unit), and waves the emitted
units at most `maxConcurrent` at a time. The conductor MUST bound this step by the emitter's
`maxConcurrent` (`resolveFanoutEffectiveConcurrency`, 1 when `gates.fanout.sequential`), NOT by
`artifact.fanout.wavePlan`: that wave plan is computed over the UNSPLIT `resolveFanoutGroups`
units and no longer matches this step's split unit set (an over-cap unit the emitter cap-splits
into ceil(N/REVIEWER_UNIT_MAX_ANGLES) sub-units would over-dispatch a single wave slot). On success
the emitter ALSO persists its emitted round plan to the keyed
`<gate>-<headSha>.emit-plan.json` sibling of the gate-context bundle
(`buildGateEmitPlanPath` in `write-gate-context.mjs`, the same
`buildGateArtifactPath` keying as every other gate artifact), with the emitter's
own result object as the body — self-describing and key-stamped — so two
concurrent emitters at different gates write distinct files by construction and
a coordinator consumes THAT keyed path, retiring the hand-rolled fixed-path
stdout-capture habit whose shared file a concurrent gate silently clobbers.
The provenance writer accepts a grouped one-angle tail only after a same-group full-cap
sibling in the emitted plan; an arbitrary standalone grouped singleton still refuses.
This is the ONE documented
dispatch path, and it closes three failure modes prose discipline never held:

- **No coordinator persona re-derivation.** The emitter resolves each assigned angle's persona
  and focus prompt via `resolveReviewerRole` against the merged `.devloops` and shipped defaults
  and carries it in the angle-suffix (see the [review agent's scoped angle-review mode](../../agents/review.md));
  an angle with no resolvable prompt refuses (exit 1) naming the angle.
  The conductor never inspects `print-gates.mjs`, `angleScopes`, or hand-authors persona text
  — reviewer composition is resolved by the emitter + the neutral bundle
  (`GATE-EXEC-BUILD-ONCE-SEED`), and the fresh-context sentinel + briefing-prefix hash are
  enforced unchanged (`GATE-EXEC-BRIEFING-PREFIX`). A reviewer running standalone (outside a
  fan-out unit) or defensively re-validating a carried role never calls `resolveReviewerRole`
  inline (`OPS-NO-INLINE-INTERPRETER`); the sanctioned standalone/defensive role source is
  `dev-loops gate resolve-role --gate <draft_gate|pre_approval_gate|review|spike> --angle <name>`
  (`@dev-loops/core/loop/review-operation`), the one authoritative exit-code boundary for
  persona/prompt/model: use the returned payload only on exit 0; a nonzero exit means stop and
  treat the angle as blocked. The owning definition of this rule is the Persona mapping bullet
  under [Pre-approval gate contract](../copilot-pr-followup/SKILL.md#pre-approval-gate-contract)
  in `skills/copilot-pr-followup/SKILL.md`.
- **Every multi-angle resolved unit shares a reviewer — configured group or auto-chunk bundle
  alike (ADR 0048 reconciles this emitter to it).** The emitter shares one reviewer
  for ANY multi-angle `resolveFanoutGroups` unit: a configured `gates.fanout.groups` group, or an
  ungrouped-leftover bundle `resolveFanoutGroups` auto-chunked into `group:...`. It records the
  resolved unit's own name as the reviewer's provenance `group`, capped and split at
  `REVIEWER_UNIT_MAX_ANGLES` (ordered `<name>-part1`/`-part2`/... sub-units, each still recording
  the whole unit's name as `group`, including a one-angle tail) exactly as an over-cap configured
  group already was. Only a genuinely single-angle unit dispatches as a singleton (no shared group). `resolveFanoutGroups`
  itself draws no dispatch-relevant distinction between a configured group and an auto-chunk
  bundle (both are "this round's resolved dispatch units"), so the emitter no longer draws one
  either. The merge guard (`fanoutReviewerPairingError` in `@dev-loops/core/loop/gate-fanin`) is
  the fail-closed authority for this. It re-derives this round's base units independently via its
  own `resolveFanoutGroups` call (`detect-checkpoint-evidence.mjs`) over the ledger's fresh and
  carried angles (so a partially carried unit resolves to its emitted boundaries), cap-split at
  `REVIEWER_UNIT_MAX_ANGLES`; base units never depend on the harness concurrency clamp. The
  dispatch plan and this re-derivation both order angles by the gate's angle pool, so ledger order
  never moves a unit boundary.
  `write-gate-findings-log.mjs` records each dispatch unit's membership (`name`, `angles`) from the
  keyed context artifact's `fanout.groups`, expanded through the emitter's cap-split, as
  `provenance.dispatchUnits`; a caller-supplied `dispatchUnits` is dropped. Both the write side and
  the read side accept a shared identity ONLY inside ONE recorded unit, and accept that unit only
  when it is a union of whole base units with at most 5 angles. An empty recorded membership is
  rejected, never read as "no check". A ledger without recorded
  membership falls back to the base units: an unpacked round still passes and a reviewer shared
  across a packed unit fails closed. A claimed group spanning angles the membership places in
  different units (or an angle it never places at all) still fails closed. The
  emitter no longer needs to be more conservative than the guard by splitting a sanctioned
  auto-chunk bundle to singletons. Provenance / distinct-reviewer / grouped-dispatch / fail-closed invariants
  are preserved (a singleton covering one fresh angle is never pair-checked, and a configured
  group's shared reviewer matches the guard's re-derivation), and this does NOT change which
  angles/units `resolveFanoutGroups` resolves — only how the emitter dispatches them.
- **Fail-closed inputs.** A missing gate-context artifact, an artifact carrying no fan-out plan
  (a thin briefing built without `--base`), an unsupported plan resolving zero units, a unit with no angles,
  a unit name that sanitizes to an invalid scope, two units deriving a colliding sanitized scope,
  a unit whose invariant-prefix record is missing, an angle with no resolvable prompt, a
  work order over the ceiling, or a work order carrying inline diff text all refuse (exit 1)
  rather than dispatching a partial, persona-less, or unbounded fan-out. Each
  unit's angle list is normalized ONCE and threaded through the scope, suffix, and provenance
  `group` derivation, so a malformed unit can never split those three views of whether it is a
  singleton.

**All-carried rounds.** Rebuild the current-head context with the proven carried angles and
prior head, then run the emitter with `--pending --carry-forward-plan <json>` using the
resolver's complete carry plan, even when every angle is carried. It writes
a keyed plan with `count: 0` and `units: []` only when its original non-empty groups are
entirely covered by the context preflight's carried angles and valid carry proof. The keyed
plan retains that proof, including prior findings and identities, and emits no reviewer prompts.
Pass that plan to both fan-in and the findings-log writer; supply fan-in's `--repo <owner/name>
--pr <n>` to bind its full round key. Retain complete carry proof,
prior findings and reviewer identities, resolved-angle coverage, and spec-authority evidence.
Fan-in independently checks carry eligibility and complete proof against the emitted plan;
the writer checks exact carried coverage, prior-head/reviewer/model/dispatch/verdict identity,
and exact carried finding contents and multiplicities, including recommendations; added or
duplicate findings fail closed because no fresh reviewer ran.
Missing, altered or fresh provenance fails closed. Same-head completed-only resumes do not qualify.
Omit `--expected-dispatch-units` at zero, as required by the existing consumer contract.

**Per-harness delivery.** Relay only the bounded work order: the emitted unit's `promptPath` bytes, unchanged. The child reviewer reads the referenced evidence after spawn, so the relay stays under `REVIEWER_WORK_ORDER_MAX_BYTES` whatever the diff or spec size:

| Dispatch | Delivery and limits |
| --- | --- |
| Code-driven Pi `runs.all` | ONE `workflowScriptPath` call per wave whose script body returns a single `runs.all([...])`, one item per emitted unit, each with its own unique `key`; the driver reads each unit's work order file and directly supplies it as the spawned reviewer's prompt, without agent paraphrase, and the reviewer reads the referenced evidence itself. Never N separate blocking per-unit calls. |
| Agent-driven Claude Code Agent/Task | Run the emitter, read the unit's work order file, and copy its exact bytes into `prompt`, with NO preamble, wrapper or paraphrase; the child reads the referenced evidence after spawn. No primitive injects those bytes independently of that agent-authored parameter. |
| Agent-driven Codex | Uses the generic batch/agent adapter, like Claude Code; only Pi ships a concrete adapter. Fixtures distinguish the generic adapters by environment. Codex production dispatch is NOT independently qualified by this repo. |

For both agent-driven harnesses, the final relay is not mechanically observed and
spawned-agent usage/cache-read telemetry is unavailable. Claim only emitted-unit
byte identity, inline alignment, ordering and fingerprints, never verified provider
reuse. `promptContentHash` binds the record atomically to the emitted file; it catches
recorded paraphrases/mismatches, not a faithful file record paired with a drifted
actual tool prompt. See "Three identities, one honest boundary" below.

**Content inlining.** Use `write-gate-context.mjs`'s generated `<gate>-<headSha>.briefing-prefix.txt` and `<gate>-<headSha>.briefing-evidence.txt`, beside the JSON context artifact. `renderBriefingPrefix` owns the prefix's fixed section order and its trailing `## Required reads` manifest. `renderBriefingEvidence` owns the evidence file's separate author-controlled body/issue fences, diff fencing and conditional trailing validation section (`GATE-EXEC-VALIDATION-ARTIFACT`). Consume both files' bytes unchanged. The renderer, never issue-body text, supplies multi-issue labels outside those fences.

`filterDiffForInline` in `@dev-loops/core/loop/review-dispatch-plan` applies `DEFAULT_DIFF_EXCLUDE_GLOBS` plus caller `excludeGlobs`; caller exclusions never replace the defaults. The builder persists the filtered diff to `<gate>-<headSha>.filtered.diff` and binds it as the required `diff` read (sha256 and bytes) in both inline and pointer mode, so the required read never grows with lockfile or generated churn. Excluded files remain in the changed-files summary. The unfiltered diff stays at `scope.diffPath`, bound as the optional hashed `raw-diff` read for widening; `git diff` in the reviewed worktree also reaches it.

The filtered diff SHOULD be inlined into the evidence file within `BRIEFING_PREFIX_INLINE_DIFF_CAP_BYTES`. Consume the builder's recorded mode:

- `inline` / `pointer`: disclosed in both artifact and evidence file. Pointer mode names the filtered diff file instead of inlining it; the required `diff` read is the same filtered file in both modes; reviewers rederive an unavailable diff with `git diff`.
- `file`: an orchestrator-supplied `--prefix-file` is recorded verbatim. The artifact discloses the mode; the supplied text gains no mode line, and no evidence file is written; `requiredReads` carries only the `prior-dispositions` entry a `--prev-head` rebuild seeds and the `known-findings` entry `--known-findings` seeds when at least one thread exists.

Every mode retains the same byte-identity requirement.

**Hunk-collapse.** `collapsePureSubstitutionRuns` owns inline compaction for the evidence file and scoped variants: only runs of at least two consecutive hunks proven to contain the same pure whole-token substitution collapse. Its purity and file-header checks preserve every nonqualifying hunk and metadata; summaries retain substitution/count/path information and access to the original diff. The persisted filtered and unfiltered diff files remain uncollapsed.

**Per-angle scoped variants.** Use emitted `angleScopes` and `briefingVariants` paths (`<gate>-<headSha>.briefing-<scope>.txt`). `renderScopedBriefingVariant` owns `changed-files` and `docs-only` slices, omitting adjacent-code material from both. Both MUST retain PR body, acceptance criteria and validation-results pointer verbatim/unabridged, plus unconditional full-evidence, full-diff and JSON-context pointers (explicitly disclose a missing diff pointer). The context builder records each written variant as a hashed `scoped-evidence` entry (`required: false`) in `artifact.requiredReads`, and the sentinel verifies it. When every angle of an emitted unit shares one non-`full` scope, the emitter copies that entry as the unit's required read, and it replaces the shared `evidence` read for that unit. A variant never replaces the invariant prefix or the other shared required reads (`GATE-EXEC-BUILD-ONCE-SEED`); widen through its pointers when needed. An empty docs slice is explicitly reported; unknown/unconfigured scope or a variant-build failure falls back to the full evidence file.

**Enforcement.** Each reviewer passes `--prefix-hash <sha256>` or `--prefix-file <path>` to `verify-fresh-review-context.mjs`, which persists it on the per-scope sentinel. Always hash the invariant prefix, never a scoped variant; variants have no separate prefix-hash record. Record an orchestrator-authored prefix through `write-gate-context.mjs --prefix-file`, never by editing record files.

Before Phase 3, fan-in MUST run `scripts/github/verify-briefing-prefixes.mjs --head-sha <sha>` and stop on failure (exit 1). The offline verifier checks sentinel hashes against per-gate prefix records, rejecting missing/mismatched or wrong-gate evidence, including a single hashless sentinel. Separate gates at the same head remain separate. Only when no prefix records exist does it use the legacy flat one-hash rule. See its `--help` for the same-head two-gate example.

**Prompt-LAYOUT enforcement (issue #1841/#1852, completes #1468).** Prefix-hash equality alone does not prove prompt layout. On the sanctioned path, `emit-fanout-dispatch.mjs` composes and records each unit's prompt in the same call, via the composer core (`compose-reviewer-prompt.mjs`'s `composeAndRecordReviewerPrompt`) through `recordDispatchPromptLayout`; there is no separate recording step to pair incorrectly or skip.

For an independently composed prompt file, the capture primitive remains callable:

```sh
scripts/github/record-dispatch-prompt-layout.mjs --scope <gate>-<angle-or-group> \
  --head-sha <sha> --prefix-path <invariant-prefix-path> \
  --prompt-file <actual-composed-prompt-path>
```

Both paths write `tmp/checkpoint-dispatch-prompt-<scope>-<headSha>.json`: leading bytes up to `DISPATCH_PROMPT_LEADING_CAP_BYTES` (`@dev-loops/core/loop/review-dispatch-plan`) and `promptContentHash`, the SHA-256 of the **entire** prompt.

**Emitted-unit binding (issue #2131).** Before Phase 3, `consolidate-fanin.mjs --head-sha` runs `scripts/github/verify-dispatch-prompt-layout.mjs --head-sha <sha>` alongside `verify-briefing-prefixes.mjs`. Every present record must satisfy both checks:

- Its full-content hash matches the canonical `<gate>-<headSha>.dispatch-prompt-<scope>.txt`, rediscovered under `<tmp-root>/gate-context/**`, never trusted from the record's stored path.
- That emitted file begins with the round's byte-identical invariant prefix **inline**, with angle-specific text strictly after it.

Missing/malformed `prefixPath` or leading bytes, missing `promptContentHash`, a missing emitted file, altered suffixes/hash mismatches, and pointer-seeded or angle-first emitted prompts fail closed (exit 1), never grandfathered.

**Three identities, one honest boundary.** This binds recorded-layout identity to generated-file identity, **not delivered-task identity**. Claude Code's orchestrator must relay emitted bytes verbatim into the Agent prompt, but the check cannot observe that final hop. It catches honestly recorded delivery drift; recording emitted bytes while delivering different bytes remains unverified. Do not present an emitted-file hash as proof of delivery. The same boundary holds for evidence reads: the sentinel proves each hashed required read still matches its recorded bytes before the reviewer starts, not that the reviewer read it in full. The per-harness delivery limitations above and `GATE-EXEC-FANOUT-DISPATCH-EMIT` still apply.

Zero dispatch-prompt records do not themselves fail this check: capture remains progressive/optional for non-composer callers, including legacy offline rounds. This does not waive the records-floor below. Recovery requires re-emitting and actually redispatching compliant prompts before reconsolidating; regenerating files cannot certify old delivery. For unchanged prefix bytes, use the same-head retry guard below. For changed bytes, follow `GATE-EXEC-ROUND-RETIREMENT`: retire before rebuilding, then redispatch. Preserve the original review history and audit records.

**Records-floor (issue #1868).** The remaining vacuous-pass shape — a coordinator round that
records ZERO dispatch/briefing evidence for a gate that DID dispatch units — is closed
mechanically: the conductor's Phase-1 request-plan artifact
(`tmp/gate-context/**/<gate>-<headSha>.dispatch-plan.json`, written by `write-gate-context.mjs`)
is the AUTHORITY for whether the round dispatched units. When `--head-sha` is given, the fan-in
derives the expected dispatch-unit floor from every persisted plan for the head (the total
pending angles across `requestGroups`) and FAILS CLOSED when the plan expects units but the round
recorded zero reviewer sentinels — an entirely-unrecorded or angle-first agent-composed dispatch
is no longer invisible to the gate. `verify-briefing-prefixes` correspondingly no longer returns
`verified: true` for `sentinels.length === 0` when the plan-derived unit count is positive. A
genuinely zero-unit gate (a plan whose `requestGroups` carry no angles — e.g. an all-carried
round) is not forced to fail, and a corrupt/unparseable plan artifact fails closed (the plan is
the enforcement authority, never silently ignorable). The optional
`--expected-dispatch-units` flag is unchanged: it still reconciles the EXACT unit count when the
caller knows it; the plan, not the flag, decides whether units were expected at all. This
reconciles and closes the records-floor residual carried on #1468.

<!-- rule: GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK -->
`GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK`: Bounded parallelism is the DEFAULT dispatch posture:
fan-out dispatches up to `gates.fanout.maxConcurrent` dispatch units concurrently per wave
(this repo: 5, with `queue.maxParallel: 3`, see Phase 2) in one wave (under Pi: ONE call per wave — one
`subagent`/`runs.all([...])` call, described above) — the gate coordinator awaits each wave before releasing
the next. `gates.fanout.sequential:
true` (effective concurrency 1, above) is the documented LOAD FALLBACK for an environment
that SIGTERMs heavy reviewers under parallel overload (ADR 0049) — a repo that enables it MUST
record why parallel execution was impractical for its environment; it is a fallback, never the
default. Neither the dev-loop coordinator nor the gate coordinator ever ends its turn mid-chain
to await a nested gate coordinator, reviewer, judge, or fixer it just dispatched — see
`END-TURN-AND-AWAIT-WAKE` in [Anti-patterns](./anti-patterns.md)
for the sanctioned blocking-join (or `bg_wait` subscription) alternative.

**Re-run rule:** In subsequent retry cycles (Phase 5), re-running is governed by
[GATE-EXEC-ANGLE-CARRY-FORWARD](#angle-carry-forward-fail-closed): carry-forward is the
default decision procedure. Dispatch the current resolved set minus proven carries;
eligible `clean` and `findings_present` angles retain their verdicts, findings and
provenance. Surface-touched, ambiguously attributed, mandatory / always-run and otherwise
unproven angles re-run. A prior finding alone does not force re-review or become clean.

<!-- rule: GATE-EXEC-DISPATCH-RETRY-BACKOFF -->
`GATE-EXEC-DISPATCH-RETRY-BACKOFF`: A dispatch that fails on a transient provider error (429
rate-limit, 5xx) MUST be retried on the SAME dispatch unit with exponential backoff
(30s/60s/120s) rather than abandoned or re-planned, so the run continues instead of the whole
drive dying and needing an orchestrator resume — safe because a reviewer's findings artifact is
an idempotent single-write at a deterministic path (`GATE-EXEC-COLLECTABLE-DISPATCH`), so
retrying the same unit can never double-write or corrupt fan-in. The retry-before-abort ordering
and the transient-vs-hard classification are encoded, testable policy, not prose the conductor
re-derives each time: the pure helper `planDispatchRetry(attempt, errorClass)`
(`@dev-loops/core/loop/gate-fanin`) returns the same 30s/60s/120s decision for a 429 or any 5xx,
and the conductor MUST consult it rather than reinvent the schedule. Only after ~3 failed
attempts on a unit (`planDispatchRetry`'s `reduceConcurrency: true`) does the conductor reduce
concurrency (halve the active batch via `backoffMaxConcurrent`, above) rather than keep retrying
at full concurrency — the round MUST NOT be aborted on a transient failure. A hard 4xx (e.g.
`402 Insufficient Balance`) is never transient (`planDispatchRetry` returns
`{ retry: false, escalate: true }`): the conductor MUST escalate to the supervisor/operator
immediately instead of retrying into the same wall. Provider choice for the retry (or any later
dispatch) is a PER-DISPATCH decision — `STICKY-PROVIDER-PIN` in
[Anti-patterns](./anti-patterns.md) forbids pinning later dispatches to a fallback provider once
a transient failure's cap window has passed.

<!-- rule: GATE-EXEC-END-OF-RUN-CONTRACT -->
`GATE-EXEC-END-OF-RUN-CONTRACT`: Once a PR has merged, the ONLY remaining steps are the
main-green check, one board-move attempt, and the final report. The conductor MUST NOT re-run
consolidation machinery (fan-in, judge, disposition-ledger writes) whose artifacts already
exist on disk for the merged head — a completed round's artifacts are its durable record,
never a prompt to redo the round. Any path the final report cites MUST be independently
verified to exist before citation, never assumed from a probe that could have failed silently
— see `SILENT-STDERR-PROBE` in [Anti-patterns](./anti-patterns.md).

#### Sentinel lifecycle

`verify-fresh-review-context.mjs` keys each sentinel by gate-prefixed scope and the
full `git rev-parse HEAD`: `tmp/checkpoint-context-sentinel-<scope>-<headSha>.json`.
With no git/head, it uses legacy `tmp/checkpoint-context-sentinel-<scope>.json`.
Old scope-only sentinels do not collide with head-keyed rounds.

A new head gets a fresh key automatically. Within one head, same-scope re-entry fails
closed (`fresh: false`, exit 1) except for the two sanctioned paths below. The
orchestrator MUST NOT manually clear sentinels between rounds or clear carried angles'
sentinels. Phase 1.2 chooses retries, including eligible findings-present carries;
retirement affects only its gate+head, never carried angles' prior-head sentinels.

**Sanctioned same-head retry.** For an interrupted reviewer or harness crash, use `verify-fresh-review-context.mjs --same-head-retry`
(deprecated alias: `--pr-body-fix-retry`). It overwrites only that scope+head sentinel
and only when supplied `--prefix-hash`/`--prefix-file` EXACTLY matches the existing
recorded hash. The reason never affects eligibility. Missing hash or mismatch fails
closed; changed briefing bytes require retirement instead.

Re-brief with the UNCHANGED invariant prefix; do not rerun `write-gate-context.mjs`.
Other angles' sentinels remain untouched and verify against the same prefix record;
no full re-fan or manual deletion is needed. A same-head retry replays the
build-time evidence file and known-findings snapshot, so it never sees a PR-body edit
or a thread posted after the build. A PR-body-only fix, or a retry that must see newly
posted threads, uses `GATE-EXEC-ROUND-RETIREMENT` (retire, then rebuild). See the
guard's `--help` for exact exit semantics.

**Sanctioned rebuild-and-retire.**

<!-- rule: GATE-EXEC-ROUND-RETIREMENT -->
`GATE-EXEC-ROUND-RETIREMENT`: A legitimate same-head rebuild, including correction
of stale/bad seeding, MUST retire the round FIRST. Phase 1's builder refuses changed
prefix bytes, or a rewrite of a prior-dispositions, known-findings or scoped-variant
file, while this gate+head has live sentinels; it never retires implicitly.
Rebuilding while reviewers run remains forbidden. A round already stranded by old
tooling or an out-of-band prefix change also uses retirement: `--same-head-retry`
cannot repair its hash mismatch.

```sh
node scripts/github/retire-gate-round.mjs --gate <gate> --head-sha <sha> --reason "<why>" \
  [--findings-dir <round artifacts dir>] [--repo <owner/name> --pr <N> | --no-findings-artifacts]
```

Use the FULL 40-character sentinel-key SHA. Retirement moves only that gate+head's
sentinels and supplied findings directory into
`tmp/retired-gate-rounds/<sha>/round-<n>/`, with `retirement.json` for audit.
The other gate's live same-head round is untouched. Then rebuild and dispatch a FRESH
fan-out whose reviewers all use the new hash.

The caller MUST pass `--findings-dir` whenever the retired round wrote artifacts:
same-head stamps alone would otherwise let stale findings enter the new fan-in.
Without that flag or `--no-findings-artifacts`, retirement REFUSES when the canonical
`tmp/gate-reviews/<slug>/pr-<N>/<gate>-<headSha>/` exists. Supply `--repo` and `--pr`
to check that path; `--no-findings-artifacts` is the explicit operator opt-out accepting
live-artifact risk. Even a no-sentinel/no-artifact no-op performs that check first.

Retired evidence stays recoverable for audit, never as input to the new fan-in.
The carry resolver also refuses equal prior/current heads, so retirement cannot
re-seed its own verdict through carry-forward. Retired sentinels sit outside the
verifier's flat live scan; divergent hashes within a live round still fail closed.

### Phase 3 — Consolidation: fan-in synthesis and disposition ledger

`consolidate-fanin.mjs --head-sha <sha>` runs the prefix and emitted-prompt layout checks before consolidation. Missing/divergent hashes, insufficient reviewer sentinels, or a recorded prompt that does not match its inline-aligned emitted unit fail closed; stop the pass on failure. The checks and their limits are owned by `GATE-EXEC-BRIEFING-PREFIX` above.

Pass `--expected-dispatch-units <n>` using the number of units Phase 2 actually dispatched from the successful emitter result (`count` / `units.length`). Reconcile that result with the collected reviewers. Neither `fanout.pendingGroups.length`, `fanout.wavePlan.length`, nor the per-angle artifact count is authoritative: the context plan is unsplit, the emitter may split units, and one reviewer may produce several angle artifacts. Omit the flag when no reviewer was dispatched; it accepts positive integers, not `0`.

The preflight's `pendingGroups` excludes fully completed/carried units only when the context was built with those inputs. Partial carries and emitter splitting can change the eventual count. Do not derive a count by subtracting groups by hand. Rebuilding and carry proof remain governed by [Angle carry-forward](#angle-carry-forward-fail-closed).

These checks have different coverage:

| Check | What it establishes |
| --- | --- |
| Request-plan records floor and supplied dispatch count | Expected reviewer records exist; a shrunken caller-supplied count cannot itself detect under-dispatch. |
| `checkFanoutAngleCoverage` in ledger, verdict and merge-evidence consumers | Configured mandatory angles and pool membership. It does not add hardcoded `ALWAYS_INCLUDE` angles or prove every non-mandatory resolved angle ran. |
| `consolidate-fanin --resolved-angles <json>` | On a computed `clean` result, each named resolved angle has an artifact or proven carry. This optional check is inactive when the flag is omitted. |

The conductor remains responsible for dispatching the complete resolved-minus-proven-carried set. Do not describe mandatory-only coverage or self-reported counts as proof of complete review. `checkResolvedAngleEvidence` is the optional angle-agnostic backstop, not a default-on guarantee.

<!-- rule: GATE-EXEC-RESOLVED-ANGLE-EVIDENCE -->
`GATE-EXEC-RESOLVED-ANGLE-EVIDENCE`: when `consolidate-fanin.mjs` is invoked
with `--resolved-angles <json>` (the round's full resolved angle-name list,
e.g. `write-gate-context.mjs`'s own context artifact `resolvedAngles`
field) and the round's computed overall verdict is `clean`, every named
resolved angle MUST have either a real per-angle artifact in `--findings-dir`
or a proven carry (a name also present in `--carried-angles`, itself only
ever populated after its own `--carry-forward-plan` proof check). A resolved
angle with neither FAILS CLOSED (exit 1), naming the missing angle(s).

<!-- rule: GATE-EXEC-CACHE-TELEMETRY -->
`GATE-EXEC-CACHE-TELEMETRY`: when a round records optional cache-telemetry evidence
(`GATE-EXEC-FIRST-WAVE-RELEASE`, `<gate>-<headSha>.cache-telemetry.json`) it MUST be validated
via `@dev-loops/core/loop/cache-telemetry-evidence` `validateCacheTelemetryEvidence`
and fail closed — refusing to proceed to consolidation — when the artifact is
missing/malformed, when verified provider reuse is claimed for a harness whose usage
telemetry is unavailable/opaque (`opaque_veracity`), when verified reuse lacks a
measured create-then-read sequence (`measured_sequence`), or when the aggregate
/token report contradicts the recorded events (`aggregate_consistency` /
`token_aggregate`) or the capability record is missing
(`capability_record`). Recording telemetry is progressive/optional: a round that
never records an artifact (e.g. a pre-slice-4 round, or one run with `--cache-telemetry`
omitted) is not newly blocked — the fail-closed path engages ONLY when the artifact
is supplied (the `--cache-telemetry` flag), so a supplied-but-invalid artifact never
passes. This enforces the Section D honesty invariant: a harness
whose cache reuse is not measurable must never be reported as a verified `1
write + N reads` result.

<!-- rule: GATE-EXEC-EXECUTION-RECORD -->
`GATE-EXEC-EXECUTION-RECORD`: a compact per-execution-unit telemetry record
(`@dev-loops/core/loop/execution-record` `buildExecutionUnitRecord`, covering
`coordinator_phase`/`reviewer_unit`/`judge_round`/`fixer_pass`/`watch_cycle`)
MUST be validated via `validateExecutionUnitRecord` and FAILS CLOSED —
`enforceExecutionUnitRecord` throws — when the record is missing/malformed,
when a provider-token dimension (input/output/cache-read tokens) is claimed
`available:true` for a harness whose telemetry-capability profile marks it
unavailable, or when the record's own `hasUnavailableProviderMetric`
convenience flag contradicts the re-derived per-dimension availability. This
is the same Section-D-style honesty invariant `GATE-EXEC-CACHE-TELEMETRY`
enforces for cache reuse, applied to per-unit cost telemetry instead: a
harness that cannot observe a metric must never report it as a measured
value, only `{available:false, reason}`. `scripts/loop/run-watch-cycle.mjs`
is the one live producer today (`buildWatchCycleExecutionRecord`, attached
to `result.executionRecord`); this is progressive/optional telemetry, not
yet a mandatory fan-in input — a cycle/round that records no artifact is not
newly blocked.

<!-- rule: GATE-EXEC-EMIT-PLAN-KEY -->
`GATE-EXEC-EMIT-PLAN-KEY`: when `consolidate-fanin.mjs` is invoked with the
optional `--emit-plan <path>` (the emitter's keyed `<gate>-<headSha>.emit-plan.json`
artifact from `GATE-EXEC-FANOUT-DISPATCH-EMIT` above), the plan's embedded
round key (`gate`, `headSha`) MUST match the round being consolidated — checked
with `GATE-EXEC-ARTIFACT-HEAD-STAMP`'s own trim+lowercase head compare — and a
mismatch, a missing/malformed key field, an unreadable/non-JSON plan, or a plan
given without `--gate`/`--head-sha` FAILS CLOSED (exit 1, "cannot verify
emit-plan key" / "is stamped for ... but this round consolidates ...") before any
`--out`/`--ledger-out` write. A rejected invocation writes no new output and
preserves pre-existing caller-owned files at those paths; callers MUST honor the
non-zero exit and MUST NOT infer success from path existence. The
flag is a guard only: the plan is never a findings or provenance source — the
gate-context bundle's `fanout.groups` stays authoritative — and omitting the
flag preserves the current fan-in behavior exactly. On the sanctioned fan-out
path, pass the same keyed plan to the later `write-gate-findings-log.mjs` call
with `--emit-plan <path> --provenance <json>`. That shared provenance-write seam
additionally verifies the full round key (`repo`, `pr`, `gate`, `headSha`) and
that the caller-supplied fresh provenance corresponds exactly to the emitted
units: the same angle set and group per angle, one reviewer identity per emitted
unit, and no under-reported `distinctReviewers` count. Carried rows are outside
the fresh emit plan and remain governed by the carry-forward proof. This second
use is still a guard only: it never derives provenance or findings from the
plan, and omitting it preserves the findings-log writer's current behavior.

Merge the parallel reviewer findings into one consolidated fix plan with the
sanctioned fan-in CLI:

```
dev-loops gate consolidate-fanin --repo <owner/name> --pr <n> --findings-dir <dir> --head-sha <sha> \
  --gate <draft_gate|pre_approval_gate> --expected-dispatch-units <n> \
  --out <path> --ledger-out <path> --spec-authority <identity-path> \
  --emit-plan <path> \
  --jq '.severityCounts' \
  [--carried-angles <json> --carry-forward-plan <json>]
```

(`scripts/loop/consolidate-fanin.mjs`), a thin wrapper over the pure
`consolidateFanin` pass from `@dev-loops/core/loop/gate-fanin` — never manual
concatenation and never an inline interpreter over the artifacts. Pass
`--head-sha <sha>` (the round's reviewed head) on every round; the fail-closed
stamp rule it activates is owned by `GATE-EXEC-ARTIFACT-HEAD-STAMP` (Phase 2).
`--gate`
applies that gate's configured `blockCleanOnFindingSeverities` to the overall
verdict; omitting it falls back to the shipped `["high"]` default. This ONE
invocation reads the per-angle artifacts directory and emits `findingsJson`
(written to `--out <path>`) — the nested per-angle shape
`upsert-checkpoint-verdict.mjs --findings-json` accepts directly, clean angles
included — plus the `{ overallVerdict, findings }` wrapper (written to
`--ledger-out <path>`) — the exact `--findings-file` input
`write-gate-findings-log.mjs` and `post-gate-findings.mjs` accept (the former
threads `overallVerdict` into the durable ledger for verdict-consistency
enforcement, #1616; the latter unwraps and ignores it), so neither tool needs
an improvised `--jq`/`node -e` extraction step to materialize it — the severity counts, and
the overall verdict, upserting the mandatory `pr-checklist` entry when
asked (`--pr-checklist clean`; since #1877 the completeness half of that
angle is enforced deterministically by the pre-approval unchecked-box block, so
this upsert records the fan-in bookkeeping entry, not the enforcement itself —
see [Acceptance Criteria Verification](acceptance-criteria-verification.md)).
Its stdout result carries `overallVerdict`,
`severityCounts` (the true, unbudgeted totals), and the `out`/`ledgerOut` paths
it actually wrote — a caller narrows that same stdout to just the severity
breakdown with `--jq '.severityCounts'` (as above) without a second
invocation, since the `--out`/`--ledger-out` writes already happened before
`--jq` renders. FAILS CLOSED (exit 1, naming the offending angles) when any
per-angle artifact is malformed or itself blocked — a blocked fan-in never
yields a publishable findings shape; fix or re-run the offending reviewer
first.

`--carried-angles <json>` (a JSON array of angle-name strings — Phase 1.2's
`plan.carried[].angle` values) upserts the proven prior verdict and findings with
`carriedFromHead: <A>` for every named angle with no Phase 2 artifact, so
a carried angle stays visible to `findingsJson`/the mandatory-angle coverage
check/the posted verdict comment instead of reading as a truncated fan-out (an
angle whose artifact was never written and is NOT named here is still
invisible to the CLI). `--carried-angles` is PAIR-REQUIRED with both `--gate`
and `--carry-forward-plan <json>` (Phase 1.2's own plan result, or just its
`carried` array) — the plan is the proof, checked against the SAME
`angleReviewSurface` predicate `resolve-angle-carry-forward.mjs`'s own producer
uses, so the two can never drift. Given without its pair, or given a name that
predicate refuses (a configured mandatory angle, a hardcoded `ALWAYS_INCLUDE`
angle — `gate-evidence`/`renderer-security`/`pr-description` — or an
unmapped/unknown angle) or absent from the plan's own `carried` list, the CLI
FAILS CLOSED (exit 1) rather than mint a fabricated clean entry. The emitted
`carriedFromHead` field marks ONLY an entry this flag upserted — every
freshly reviewed angle's entry omits it — so `--out`'s own shape, not just the
ledger's `provenance.perAngle`, distinguishes carried from fresh. A `findings_present`
carry retains its open findings and their blocking effect; only a clean carry has
an empty findings array (legacy plans without `prevVerdict` default to clean).

`--out`/`--ledger-out` are also rejected at
parse time (exit 1) when they resolve to the same path as each other, or when
either resolves to a direct top-level sibling of the artifacts inside
`--findings-dir` (a subdirectory of `--findings-dir` is fine — artifact
discovery is top-level-only).

The render budget limits the visible-comment shape (`--out`), never the complete `--ledger-out`. The CLI measures fit through `upsert-checkpoint-verdict.mjs`'s renderer. It halves each finding's summary cap down to 16 characters, retaining real finding text, angles and verdicts. Never replace findings with synthetic omitted-count or local-ledger-pointer markers: a runner-local ledger is not visible to GitHub readers.

| Render result | Consolidation output |
| --- | --- |
| Fits, including after truncation | Per-angle findings in `--out` if requested; `commentBudgetExceeded` absent. |
| Still too large at the 16-character floor; `--ledger-out` supplied | Exit 0, `commentBudgetExceeded: true`, `findingsJson: []`; withhold `--out` and remove any stale file at that path. The full ledger remains available. |
| Still too large; no `--ledger-out` | Fail closed (exit 1): stdout alone is not a durable record for the sanctioned ledger/post path. |

After successful consolidation, the [Gate comment command](../copilot-pr-followup/SKILL.md#mandatory-gate-comment-command-contract) caller MUST check that `--out` exists before passing `--findings-json <path>`; an absent path fails closed with ENOENT. For a withheld round, use `--findings-summary` naming the round size and complete `--ledger-out` location. Omitting `--findings-json` does not remove the `--findings-severity-counts` requirement: a `clean` verdict under a gate with `blockCleanOnFindingSeverities` configured still requires it, regardless of execution mode.

Coverage follows `GATE-EXEC-ANGLE-COVERAGE` through shared `checkFanoutAngleCoverage`:
the verdict writer checks `--findings-json`, or, when absent, the matching
`--findings-ledger`'s `provenance.perAngle`. This applies to every `fanout_fanin` post
without structured findings, not only budget-withheld rounds. Missing mandatory angles
or invalid provenance fail closed when the gate requires mandatory angles; foreign
angles fail unless `gates.rejectForeignAngles: false` explicitly selects warning mode.
A gate with no mandatory angles does not require either proof artifact, but valid
supplied provenance still undergoes angle-name and pool checks. Every check uses the
gate's resolved pool; the independent merge-evidence read remains a backstop.

A withheld round MUST write the complete log with `write-gate-findings-log.mjs
--provenance` and pass `--findings-ledger` to the verdict post. Independently of
`gates.requireFanoutProvenance` (default `false`), gates with mandatory angles have these guards:

- `upsert-checkpoint-verdict.mjs` refuses a `fanout_fanin` post lacking BOTH
  `--findings-json` and `--findings-ledger`, naming the missing proof flags.
- `write-gate-findings-log.mjs` refuses a `fanout_fanin` write lacking both explicit
  and wrapper-supplied provenance, writes no ledger, and names the mandatory angles.
  Its default `inline_single_agent` mode is exempt from that absence guard. Whenever
  explicit or `--findings`/`--findings-file` wrapper provenance is supplied, coverage is checked.
- `detect-checkpoint-evidence.mjs` rejects absent/invalid mandatory-angle provenance
  by default. Only the CI verifier uses `--skip-fanout-ledger-check`; sanctioned
  pre-merge checks MUST NOT use that flag.

`commentBudgetExceeded: true` exactly means `--out` was withheld; a fitted round,
even at the 16-character truncation floor, has no flag. On withheld rounds,
`findingsJson: []` is a rendering result, not zero findings: pass the consolidation's
true `severityCounts` through `--findings-severity-counts` so the posted
`**Findings summary:**` digest retains real totals. The complete ledger always does.

Consolidation:

- collate findings from all review angles
- classify each finding: `high`, `medium`, `low` (defects), or `question`/`nit`
  (non-defects) — severity is the reviewer's advisory weight only; deferral is a
  DISPOSITION — derived at fan-in for non-blocking findings, finalized per thread by the
  fix cycle / gate close — so no severity is spelled "defer" — and a severity/round
  eligibility rule is never sufficient merit for closure. Calibrate severity to
  CONSEQUENCE, not diff size: a defect that breaks correctness on a reachable path, or opens
  a fail-open / security / fail-closed gap, is at least `medium` — never `low` — no matter how
  small the change; `low` is reserved for a real defect with no operator-visible consequence.
  Under-labeling a real correctness/fail-open defect as `low` is a calibration defect: the
  internal gate must rate such a finding comparably to an external reviewer, not lean on a
  later Copilot round to re-surface it at the correct severity. Every resolve-without-fix
  reply for a low, medium, or nit MUST include an `Examined on merits:` rationale
  identifying the finding and its scope, acceptance-criteria, fix-window, or filing-bar
  basis; a severity-only dismissal is non-conforming. The pre-rename spellings
  (`must-fix`, `worth-fixing-now`, `nice-to-have`, `defer`) are normalized to their
  canonical replacement on read. A LOCATABLE `question` is answered, never deferred: the
  fixer replies (an answer that reveals a defect promotes it to `high`/`medium`/`low`; an
  unanswerable question escalates to the author), and an unanswered question blocks
  gate-close exactly like an open defect. ONE exception (ADR 0088): a `question` the judge
  disposed `reject` never enters the fixer's act list, so a question the operator or fixer
  answers on the merits AFTER the judge rejected it has no reply-and-resolve actor left —
  `close-gate-findings.mjs` reject-closes it instead, citing the judge's rejection rationale
  in the closing reply; this is a reply-and-resolve, never a `disposition=deferred` stamp,
  and is never listed in the deferral comment (a question is never fileable). Still unanswered, it still
  blocks; still judge-`act`, it is still owned by the fixer's own answer-and-resolve path,
  unchanged. Still judge-`defer`, judge-pass only lists it in the deferral comment — no path
  resolves the thread, so an answered, judge-deferred question needs an operator decision.
  A NON-LOCATABLE `question` has no resolvable
  thread to answer through — it is body-filed and deferred by construction, exactly like
  every other non-`high` body-filed finding (`GATE-EXEC-DEFERRAL-RECORD`). A `nit` is a
  cosmetic, non-defect finding resolved-with-rationale immediately, with no fixer cycle
  and no deferral comment entry: a `nit` is NEVER filed (net-reduction disposition
  policy, `GATE-EXEC-THREAD-DISPOSITION`).
- write the disposition ledger: every finding receives a severity classification and a
  disposition (accepted-for-fix, deferred, needs-answer, disputed, or operator_acknowledged) —
  needs-answer applies only to a LOCATABLE question; a non-locatable one gets deferred
- produce a merged findings artifact
- determine the overall gate verdict:
  - `clean`: no findings with a severity in the gate's `blockCleanOnFindingSeverities` list remain
  - `findings_present`: one or more findings with a blocking severity remain
  - `blocked`: the gate could not complete or a hard blocker prevented a verdict

Ledger content and write-before-comment sequencing are owned by
`GATE-EXEC-DISPOSITION-LEDGER` below.

<!-- rule: GATE-EXEC-POST-BEFORE-FIX -->
`GATE-EXEC-POST-BEFORE-FIX`: The round's findings MUST be visible on the PR **before** the
fix cycle in Phase 4 begins, so they are auditable and Copilot/humans are aware of them.
Fixes MUST NOT be applied until that trail exists. The trail is the round's own verdict
review (`GATE-COMMENT-SINGLE-SURFACE`): its inline finding comments plus the body-filed
findings under the verdict fields, posted by `upsert-checkpoint-verdict.mjs --findings-ledger
--spec-authority <identity-path>` (the same identity artifact from the Spec-context seam above,
threaded onto the posted verdict record by default — issue 2008 / ADR 0061 AC1) in one call, so
the findings and the verdict land together and no separate post step can be
skipped or reordered. The disposition ledger is written before that post
(`GATE-EXEC-DISPOSITION-LEDGER`) and regardless of it.

`post-gate-findings.mjs` renders the same findings a SECOND time, as a consolidated
marker-tagged PR issue comment grouped by severity. It is governed by
`gates.postFindingsComments` (resolved via `resolveGatePostFindingsComments(config)`,
default false / opt-in) and no-ops with a `skipped` result unless a repo explicitly turns
it on. A repo that does opt in accepts duplicated finding text on a second surface for
every reader; nothing in the gate flow requires it. This comment is itself bounded by
GitHub's per-comment character limit: a round large enough to approach that limit degrades
by dropping individual findings, least-urgent first (across every less-urgent severity before
touching a more-urgent one), so a round only slightly over the limit loses close to only as
many low-priority findings as it takes to fit — never posting an over-limit body, though the
search can occasionally settle on dropping a few more findings than the true minimum — naming
what was omitted in the posted comment and pointing at the disposition ledger (always complete,
never bounded) as the full record; a round that cannot fit even with every finding dropped, nor
with only its single most-urgent finding kept, fails the post closed rather than reporting
success. Do not assume this comment alone carries every finding of a large round — the ledger
is the one surface with that guarantee.

Because the findings ride the verdict review itself, they occupy the same post-verdict,
pre-fix slot relative to Phase 4 — unresolved threads exist on the PR before any fix is
attempted. On `pre_approval_gate`, an unresolved review thread forbids the gate's own next
actions, which is why that slot matters there; the same slot is kept for `draft_gate` too,
for uniformity, even though the draft boundary does not carry that specific refusal.

### Phase 3.5 — Judge: relevance disposition (#1525)

<!-- rule: GATE-EXEC-JUDGE-PHASE -->
`GATE-EXEC-JUDGE-PHASE`: After fan-in (Phase 3) and before the fix pass (Phase 4), the
gate coordinator dispatches the dedicated `judge` agent (`agents/judge.agent.md`). The judge holds
the linked issue's acceptance criteria, definition of done, and non-goals, the PR's declared
scope, and the prior rounds' judge ledgers, and decides — per finding — whether this PR is
the place to act on it. This is the relevance axis; it is distinct from and complementary
to the severity-based disposition `deriveDisposition` owns (accepted-for-fix / deferred /
needs-answer), which stays intact.

**Inputs:** the consolidated disposition ledger (`consolidate-fanin`'s `{overallVerdict,
findings}`), the linked issue's AC / DoD / non-goals, the PR's declared scope, the
prior-round judge verdict artifacts for this gate, and — engaged by default on every gate
round (issue 2008 / ADR 0061) — the structured spec plus `specDigest`/`headSha`/`contentDigest`
the conductor derives via `scripts/loop/spec-context.mjs` (see the Dispatch bridge below).

**Output:** the judge writes two verdict artifacts to deterministic paths under
`tmp/gate-judge/<repo-slug>/pr-<N>/<gate>-<headSha>/` — its only writes: the relevance verdict
(`judge-verdict.json`) and the spec-authority verdict (`spec-authority-verdict.json`, see
`agents/judge.agent.md` "Immutable spec authority"). The relevance verdict's shape is validated
by `validateJudgeVerdict` (`@dev-loops/core/loop/gate-fanin`):

```json
{
  "headSha": "<sha>",
  "scopeDrift": { "verdict": "within_scope|drift_detected", "rationale": "...", "driftedAreas": ["..."] },
  "dispositions": [{ "index": 0, "disposition": "act|defer|reject", "rationale": "...", "criterion": "...", "followUpDraft": { "title": "...", "body": "..." } }]
}
```

- `index` is the 0-based position of the finding in the consolidated ledger's `findings`
  array. One disposition per finding.
- `act` — a genuine defect or in-scope gap relevant to this PR's acceptance criteria / definition
  of done (a correctness bug, a fail-open/fail-closed gap, a security regression, or an AC-breaking
  defect), plus the non-defect `act` cases named below (a `nit` riding an already-planned fix pass;
  an admitted coverage-expansion request); the fixer addresses it. Severity is an INPUT to the judgment, never an auto-gate:
  the judge adjudicates EVERY finding — INCLUDING a `low` — on its merits, and a real defect
  is `act` regardless of its severity label. Round 1 is the cheapest fix point, so a real
  AC-relevant `low` is acted up front, never auto-deferred on its label.
- `defer` — real but belongs in a follow-up; MUST carry a `followUpDraft` (soft-cap contract):
  the draft is the durable ledger record, and `judge-pass`'s batched deferral comment on the
  comment target records the deferral (`GATE-EXEC-DEFERRAL-RECORD`). The defer bar is high (net-reduction policy): a `nit` MUST NOT get
  a verdict `disposition` of `defer` (merged into the ledger as `judgeDisposition`; `act` —
  only when it rides an already-planned fix pass — or `reject`, and the resolved thread note
  is its record; this governs the relevance/filing axis only, while the severity-derived
  `disposition` field keeps its own deferred-with-no-fixer-cycle semantics for nits), and a
  `low` adjudicated as a genuine AC-relevant defect is `act` (above), never deferred or
  rejected on its severity label; a `low` that is real but out of this PR's scope MUST be
  deferred only when leaving it unfixed would change an operator-visible outcome (wrong
  guidance a conductor executes, a fail-closed gap reachable on a sanctioned path, or a
  demonstrable bug), and a genuinely non-blocking/cosmetic `low` that clears none of those
  defaults to `reject`. When the judge's briefing
  names an existing open issue covering the finding's territory, the `followUpDraft` MUST be
  titled `Append to issue N: ...`. Beyond that record, the conductor at most appends a comment
  to an existing covering issue (via `comment-issue.mjs`), and it files a new issue from a
  deferred finding only when the finding is a blocker (`MAIN-AGENT-FILING-BLOCKER-ONLY` in the
  [main-agent contract](main-agent-contract.md)).
- `reject` — out-of-scope against a named non-goal or scope boundary, or below the defer
  bar; this PR is not the place, and a follow-up is not warranted.
- `rationale` MUST name the criterion, non-goal, scope boundary, or defer-bar test the
  disposition turns on (a below-the-bar reject names the bar it failed, never a fabricated
  non-goal).
- `scopeDrift.verdict` is the PR-as-a-whole scope-drift verdict, distinct from the
  per-finding dispositions.

**Merge seam.** The conductor enriches the consolidated findings with the judge's
dispositions via `applyJudgeDispositions(findings, judgeVerdict)` (`@dev-loops/core/loop/gate-fanin`,
pure, fail-closed on a malformed verdict, an out-of-range index, or dispositions that do not
cover every finding), then writes the durable
ledger via `write-gate-findings-log.mjs --judge-verdict <path> --spec-authority <identity-path>`
(the same identity-stamp artifact the Spec-context seam below produces). The enriched findings carry
`judgeDisposition` / `judgeRationale` / `judgeCriterion` / `followUpDraft` so the disposition
ledger and the posted findings comment show what was consciously not acted on and why
(`GATE-EXEC-POST-BEFORE-FIX`'s single-surface verdict review renders the judge suffix).

**Disposition memory into a re-running reviewer's briefing (issue 2175).** On a head-bump
re-gate, `write-gate-context.mjs --prev-head <A>` (mirrors `resolve-angle-carry-forward.mjs`'s
own `--prev-head` vocabulary) reads head A's durable findings-log and seeds every
`reject`/`defer`-disposed finding attributed to an angle re-running THIS round (an angle in
`--angles` not named in `--carried-angles` — a carried angle's reviewer never re-runs, so it
gets no hint) by reference. The full list (fingerprint, angle, severity, summary,
`judgeRationale`, in the prior log's own order, never truncated) goes to the round-bound
`<gate>-<headSha>.prior-dispositions.json`, recorded as a hash-bound `prior-dispositions`
required read in `requiredReads`. The rendered volatile tail carries only a "Prior-round
dispositions (do not re-raise a rejected finding at a shifted severity)" line with the entry
count and that read line, so a large prior log never grows the reviewer prompt. An `act` (still-open) disposition is
deliberately excluded — it is live findings territory, not do-not-re-raise memory. `--prev-head`
is rejected outright (fail-closed) when it names the same head as `--head-sha`, checked in both
prefix directions so a full 64-char head and its 40-char prefix are also caught. Past that
guard the flag is purely additive and FAILS OPEN: an absent (first round), unreadable,
malformed, identity-mismatched, or verdict-ineligible (not `clean`/`findings_present`) prior log
renders a byte-identical volatile tail to omitting the flag; it never blocks the write,
suppresses a finding, or converts a `reject` into an approval — it only hints a reviewer away
from re-litigating settled ground.

**Spec-context seam (default-on, issue 2008 / ADR 0061).** Before fan-out dispatch (so its output
is available to every writer for the whole round, including Phase 3's fan-in ledger), the
conductor always runs `scripts/loop/spec-context.mjs` to derive the run's spec/digest identities
so nothing hand-derives them:

```sh
content_digest=$(node scripts/loop/spec-context.mjs --repo <owner/name> --issue <linked_issue_number> \
  --content-file <reviewed-content-path> --head-sha <current_head_sha> \
  --spec-out <spec-path> --identity-out <identity-path> --jq '.contentDigest')
```

On a fixer-push re-entry round (a prior clean round's `--approvals-out` record exists), it also
derives the AC7 affected-criteria producer's input:

```sh
node scripts/loop/spec-context.mjs changed-paths --base <prior_approved_head_sha> --head <current_head_sha> \
  --jq '.changedFiles' > <changed-paths-path>
```

**AC1 — one identity stamp, every durable record writer (issue 2008 / ADR 0061).** The SAME
`spec-context.mjs` call above also writes the round's revision-identity stamp once via
`--identity-out <identity-path>` (`{ specDigest, headSha, contentDigest, checkedCriteria }`,
`buildRevisionIdentity` + `specCriterionIds` under the hood — see
`packages/core/src/loop/spec-authority.mjs`). The conductor passes `--spec-authority
<identity-path>` to every durable record writer this round invokes, by default, on every round:
`consolidate-fanin --spec-authority <identity-path>` (Phase 3's fan-in ledger),
`write-gate-findings-log.mjs --spec-authority <identity-path>` (this section, above),
`upsert-checkpoint-verdict.mjs --spec-authority <identity-path>` (the posted verdict record), and
— on a carry-forward round — `resolve-angle-carry-forward.mjs --spec-authority <identity-path>`
(the carry-forward plan). Each writer threads the identity through the ONE shared
`stampSpecAuthorityIdentity`/`stampOptionalSpecAuthority` helper (`scripts/lib/spec-authority-stamp.mjs`),
never recomputing it, so every gate/fixer/carry-forward record pins both revision identities and
the checked criteria — re-entry-safe from any record type, not only the judge/approval records
(judge-pass's own `--ledger-out`/`--approvals-out` already carry the identities natively via its
`--spec-file`/`--content-digest`/`--spec-authority-verdict` flags below).

**Dispatch bridge (runtime wiring, #1658).** After the judge agent writes its verdict
artifacts and the durable ledger is written with `--judge-verdict`, the conductor runs the
deterministic bridge `scripts/loop/judge-pass.mjs` (`dev-loops gate judge-pass`) to derive
the fixer's **act list** for Phase 4: given `--findings-file` (the consolidated ledger) and
`--judge-verdict` (the judge's relevance-verdict artifact path), `judge-pass` validates the
verdict shape, fails closed unless the verdict's `headSha` matches the current head (a stale
verdict must never feed the fixer), applies the dispositions via `applyJudgeDispositions`, and
emits exactly the findings the judge marked `act` (`--out`) plus the enriched ledger
(`--ledger-out`). Every invocation ALSO carries the spec-authority flags derived above —
`--spec-file <spec-path> --content-digest "$content_digest" --spec-authority-verdict
<spec-authority-verdict-path>` — plus `--prior-approvals`/`--approvals-out` across re-entry
(the first round on a fresh approval chain has no prior-approvals record to pass yet), and
`--changed-paths`/`--coverage-map` together only when a coverage map exists and this round is
a fixer-push re-entry (`resolveAffectedCriteria`, ADR 0061 AC7; otherwise `judge-pass` keeps its
all-stale fallback):

```sh
dev-loops gate judge-pass --repo <owner/name> --pr <N> --gate <gate> --head-sha <current_head_sha> \
  --findings-file <ledger-path> --judge-verdict <verdict-path> --out <act-list-path> --ledger-out <enriched-ledger-path> \
  --spec-file <spec-path> --content-digest "$content_digest" --spec-authority-verdict <spec-authority-verdict-path> \
  [--prior-approvals <prior-approvals-path> --approvals-out <approvals-out-path>] \
  [--changed-paths <changed-paths-path> --coverage-map <coverage-map-path>]
```

The conductor hands the act list — never the full unfiltered ledger —
to the fixer pass (`GATE-EXEC-JUDGE-AUTHORITY-SPLIT`). If `judge-pass` fails closed (stale
head, malformed verdict, out-of-range index, undisposed finding, mismatched spec-authority
identity), the conductor re-runs the judge at the current head rather than degrading to
severity-only disposition or silently skipping spec authority for a wired gate. See
`skills/docs/spec-authority-contract.md` for the enforcement rules these flags carry.

`judge-pass` is also where a judge `defer` is recorded (`GATE-EXEC-DEFERRAL-RECORD`): every
`defer`-disposed finding gets a stable `fingerprint`, and the round's defers go as ONE batched
comment on the deferral comment target via `commentDeferredFindings`
(`scripts/github/_gate-finding-surface.mjs`). The target is the PR's linked spec issue when
`tracker.provider` resolves to `github` and the PR has exactly one closing issue reference;
otherwise it is the PR itself. `judge-pass` never creates an issue and never writes a tracker
other than GitHub. The comment goes through the sanctioned `commentIssue` from
`@dev-loops/core/github/issue-ops`, never a raw `gh` call. `close-gate-findings.mjs`'s own
severity/round-based defer routes through the SAME `commentDeferredFindings`, so both paths
converge on the same target. Each `defer` finding's ledger entry carries `followUpIssueNumber`,
the target's number (a PR number is a valid comment target); a `reject` carries neither a target
link nor a follow-up draft, only its `fingerprint` and rationale (the one-line audit entry).
Re-running `judge-pass` for the same round reads the target's existing comments first and does
not append a fingerprint the target already lists. A thread whose finding the judge disposes
`act` is never defer-closed; it stays open until the fixer replies with the fixing commit or a
decline reason and resolves it (see `GATE-EXEC-THREAD-DISPOSITION`).

<!-- rule: GATE-EXEC-JUDGE-AUTHORITY-SPLIT -->
`GATE-EXEC-JUDGE-AUTHORITY-SPLIT`: The judge owns **relevance** (is this finding for this
PR?); the fixer owns **reproduction** (does this finding reproduce / is it a real defect?).
The fix pass (Phase 4) consumes **only the `act` list** and retains reproduction-based
rejection — a finding that does not reproduce is dead regardless of what the judge decided —
but stops being the actor that decides relevance. The judge does NOT soften `must-fix` on
correctness grounds: a real defect stays a real defect; the judge decides *where* it is
fixed, not *whether* it is real. When no judge verdict is present (a gate that has not yet
wired the judge phase), the fixer falls back to the existing severity-based disposition.

<!-- rule: GATE-EXEC-JUDGE-NOT-FRESH -->
`GATE-EXEC-JUDGE-NOT-FRESH`: The judge is the one actor that must NOT be fresh-context per
round. Reviewer fresh-context isolation (`GATE-EXEC-BUILD-ONCE-SEED`) is unchanged — the
judge is a separate agent dispatched after fan-in, not a reviewer. The judge is the
designated memory: it sees the round history precisely so it can notice accretion,
self-renewing churn, or findings-about-a-fix. It is seeded with the conductor's accumulated
state (prior-round ledgers, scope history) rather than a blank slate — the conductor hands
it the prior-round judge verdict artifacts as an explicit input, so its memory is durable
and auditable rather than implicit.

### Phase 4 — Fix

If findings with a severity in the gate's `blockCleanOnFindingSeverities` list are present:

- When a judge verdict is present (Phase 3.5), the fix pass executes **only the `act` list**
  — findings the judge marked `act`. The fixer retains reproduction-based rejection (a finding
  that does not reproduce is dead regardless of the judge's verdict) but stops deciding
  relevance (`GATE-EXEC-JUDGE-AUTHORITY-SPLIT`). When no judge verdict is present, the fixer
  falls back to the severity-based `blockCleanOnFindingSeverities` set below.
- apply only the accepted narrow fixes on the same branch
- do not broaden scope or touch unrelated files
- run the smallest honest validation for the accepted fix scope
- commit and push fixes on the branch; for a judge act-list fix, push only after the
  delta pre-push review (`PRE-PUSH-DELTA-TRIGGER` in [Pre-push review contract](pre-pr-review-contract.md#delta-mode))
- <!-- rule: GATE-EXEC-BLOCKING-ONLY-FIX --> `GATE-EXEC-BLOCKING-ONLY-FIX`: At every round,
  the fix cycle covers every finding whose severity is in the gate's
  `blockCleanOnFindingSeverities` set. Through this gate's configured medium fix
  window (default 3, `gates.<gate>.mediumFixWindow` — the deprecated
  `worthFixingNowFixWindow` key is still honored as an alias, `mediumFixWindow`
  wins when both are set; #1581) of the gate's chain, it also covers
  every open LOCATABLE medium finding — one anchored to an in-diff `file:line` and
  tracked through its own resolvable review thread per `GATE-EXEC-FINDING-THREADS` — fixed the
  same way even though that severity is not in the blocking set. From the next round on (round 4
  under the default window), an open
  locatable medium finding is no longer fixed inside the gate: it is deferred per
  `GATE-EXEC-THREAD-DISPOSITION` instead. A NON-LOCATABLE medium finding (body-filed:
  no code location, so it never gets a thread to fix through) is outside this round window
  entirely — it is deferred by construction at post time, at any round, per
  `GATE-EXEC-DEFERRAL-RECORD`. A low finding is a fixer TRIAGE target, not a silent
  auto-defer (#1585): the fixer receives every gate-authored finding (high,
  medium, AND low) as a fix/triage target and may fix-if-cheap-in-the-same-commit
  (free polish when already touching that code), else defer. Defer is permitted from round 1 on for
  low findings — no forced fix window (the medium window (#1581) is unaffected). A low the JUDGE
  disposed `act`, however, is a fix target rather than a triage-defer candidate: the fixer may
  decline it only on reproduction grounds (`GATE-EXEC-JUDGE-AUTHORITY-SPLIT`), exactly as a judge
  `act` overrides a nit's no-fixer-cycle default — this is what makes a real AC-relevant low get
  fixed up front rather than re-deferred one stage downstream on its severity label. A LOCATABLE
  question is a fixer ANSWER target, never fixed or deferred: the fixer replies with an answer
  (promoting the
  finding to a defect severity if the answer reveals one, or escalating to the author when
  unanswerable); an unanswered locatable question blocks gate-close exactly like
  an open defect (see `GATE-EXEC-THREAD-DISPOSITION` below). A NON-LOCATABLE question (body-filed)
  is, like every non-high body-filed finding, deferred by construction at post time per
  `GATE-EXEC-DEFERRAL-RECORD` — the answered/never-deferred contract applies only to a locatable
  question's own resolvable thread, which is the only surface an answer reply can land on. A nit
  is resolved-with-rationale immediately at round 1, never filed, with no fixer cycle on the
  severity axis (judge-acted nits excepted). Two layers
  govern this, and they stay distinct: the LEDGER verdict is `clean` whenever
  no finding at a blocking severity remains, computed from `blockCleanOnFindingSeverities` alone
  and never from an open medium thread; an unresolved in-window locatable
  medium THREAD still forces another fix round, but through the unresolved-feedback
  routing `GATE-EXEC-THREAD-DISPOSITION` owns, not by changing what the ledger verdict `clean`
  means. GATE-CLOSE is a third, stricter layer (see `GATE-EXEC-THREAD-DISPOSITION` below): a
  clean verdict is NOT sufficient to close the
  gate — every gate-authored review thread (any severity) must be resolved (fix-closed by the
  fixer, answered for a locatable question, defer-closed by the disposition pass, or reject-closed
  by `close-gate-findings.mjs` for an answered, judge-rejected question, ADR 0088) first, asserted by
  `fetchDraftGateEvidence` /
  `ready-for-review.mjs` / `pre-pr-ready-gate.mjs` (and the `draftGateSatisfied` field fold in
  `detect-checkpoint-evidence.mjs`) as 0 unresolved gate-authored threads
  (`GATE-EXEC-THREAD-DISPOSITION`). Widening the blocking set is a per-gate config decision (`blockCleanOnFindingSeverities`),
  never a round-by-round judgement call.

### Phase 5 — Repeat until clean

After applying fixes and advancing the head SHA:

- <!-- rule: GATE-EXEC-REGATE-MANDATORY --> `GATE-EXEC-REGATE-MANDATORY`: **Re-gate is mandatory:** a new head SHA MUST always trigger a fresh full-chain gate pass; the gate MUST NOT be skipped because a previous head was clean. The `draft_gate` one-time skip is a narrow exemption from this rule that only applies after the PR has left draft ([GATE-COMMENT-DRAFT-REQUIREMENTS](./gate-review-comment-contract.md#draft-gate-draft_gate-comment-requirements)); while the PR is still draft, every new head is re-gated per this rule.
- rerun the sub-loop from Phase 1 (context-builder preamble for the new head SHA)
- continue the fix-then-retry cycle until the synthesis verdict is `clean`
- on retry, re-invoke every reviewer whose review surface the new head's delta touched (including any angle whose prior finding attribution is ambiguous), and re-invoke every mandatory / always-run angle; the context-builder and consolidation always run fresh. A previously-clean **or** unambiguously-attributed `findings_present` angle whose surface the delta provably did NOT touch is by default **carried forward** per [GATE-EXEC-ANGLE-CARRY-FORWARD](#angle-carry-forward-fail-closed) below — a carried `findings_present` angle brings its open findings forward and the round still blocks on them — on that rule's proof and never on guesswork
- a clean pass means all gate-specific review angles pass and no findings with a severity in `blockCleanOnFindingSeverities` remain

#### Angle carry-forward (fail-closed) {#angle-carry-forward-fail-closed}

<!-- rule: GATE-EXEC-ANGLE-CARRY-FORWARD --> `GATE-EXEC-ANGLE-CARRY-FORWARD`: On every head bump A→B,
run the carry-forward decision procedure by default. Carry a prior `clean` or
`findings_present` angle ONLY when the delta provably leaves its review surface
untouched and every guard below passes. Without proof, `carryForward` remains false.
Dispatch the current resolved set minus proven carries; touched, mandatory/always-run
and ambiguously attributed angles re-run. No prior head, an ineligible prior-log verdict
or any whole-plan refusal means full re-dispatch. Context-builder and consolidation
always run fresh at B; this never exempts a round from `GATE-EXEC-REGATE-MANDATORY`.

Eligibility is decided PER ANGLE by the delta against that angle's review surface —
`clean` OR `findings_present` both carry when the delta provably misses the surface.
There is no "the prior round was not clean, so nothing carries forward" rule: the
overall verdict of the prior round never gates carry-forward, and a re-gate NEVER
skips the resolver on the theory that a non-clean prior round re-fans everything. The
one and only skip is a gate's genuine FIRST round (no prior findings-log at any head);
every subsequent head bump runs the resolver, enforced below.

<!-- rule: GATE-EXEC-CARRY-FORWARD-PLAN-REQUIRED --> `GATE-EXEC-CARRY-FORWARD-PLAN-REQUIRED`
(issue #2251): a re-gate MUST NOT dispatch a reviewer until carry-forward has been
consulted at the current head. `resolve-angle-carry-forward.mjs` records its result as
the keyed `<gate>-<headSha>.carry-forward-plan.json` artifact
(`buildCarryForwardPlanPath` in `write-gate-context.mjs`) at head B — on BOTH the
success path (`ok: true`, with `carried`/`mustRerun`) and the ONE genuine carry-forward
ELIGIBILITY refusal: a readable, well-formed prior log whose verdict is simply not
carry-eligible (`ok: false, fallback: true`, whose contract outcome is a safe full
re-dispatch). Everything else records NO marker, so the emitter fails closed on the
re-gate: an OPERATIONAL failure (a `--prev-head` that resolves no log, a
mismatched/unreadable log, a wrong worktree, a git/IO error) AND a prior-log INTEGRITY
failure (a corrupt/truncated/inconsistent ledger — missing `provenance.perAngle`, a
malformed `headSha`, an unattributable finding, a `findings_present` verdict with no
findings, a duplicate angle) are both treated the same: carry-forward could not be
soundly evaluated, so no marker is written and a wrong/guessed `--prev-head` or an
untrustworthy ledger can never be laundered into "the resolver ran". The resolver also REMOVES any
stale plan artifact for this `(repo, pr, gate, headSha)` at the START of every run, so each invocation is
authoritative and a prior successful run's artifact is never laundered into proof that a later failed
retry succeeded. The
fan-out emitter (`emit-fanout-dispatch.mjs`, `GATE-EXEC-FANOUT-DISPATCH-EMIT`) is the
enforcing chokepoint: on a re-gate head (a durable findings-log for this gate exists at
an EARLIER head — established by reading each candidate log's OWN recorded FULL identity
(`repo`/`pr`/`gate`/`headSha`), never by trusting a filename alone) it REFUSES to emit — spawning zero reviewers —
unless a plan artifact is recorded at the current head that is a genuine resolver
outcome (`ok: true`, or `ok: false` with `fallback: true`), whose
`(repo, pr, gate, headSha)` key matches this round, AND whose `prevHead` names one of
the actual prior findings-log heads. The emitter is chosen over the post-hoc ledger
seam because it fails earliest — before the wasted fan-out this rule exists to prevent.
Only `draft_gate` / `pre_approval_gate` carry forward; the review gate has no resolver
and never guards here.

Derive each angle's prior verdict from the prior log's findings, never its overall
verdict: ANY finding at ANY severity makes that angle `findings_present`, even in an
overall `clean` round. A findings-present carry retains its EXACT findings unchanged,
open and blocking as before, including findings left in review threads. An open finding
alone does not require re-review. Attribution to exactly one `provenance.perAngle` row
permits carry; attribution to multiple rows forces re-review regardless of surface.

The decision is a pure, deterministic, fail-closed seam — `resolveAngleCarryForward` / `resolveCarryForwardAngles` in `@dev-loops/core/loop/gate-carry-forward` — driven by the CLI `scripts/github/resolve-angle-carry-forward.mjs --repo <r> --pr <n> --gate <g> --prev-head <A> --head-sha <B> --spec-authority <identity-path>` (run from the worktree at head B; `--spec-authority` stamps the round's identity onto the carry-forward plan by default, issue 2008 / ADR 0061 AC1). It reads the prior findings-log for head A whose overall verdict is `clean` OR `findings_present`, computes the touched-surface delta, and returns per angle `carryForward: true|false` with a reason.

**Delta basis — base-relative incremental (issue #2292).** The touched-surface delta is the two-dot tree diff `git diff A..B` (files changed since the reviewed head A) MINUS files already on the PR's base branch at head B — equivalently `(A..B) ∩ (base..B)`, computed by `captureMainRelativeChangedFilesSince` in `scripts/lib/git-delta.mjs`. The exclusion ref is the CONFIGURED base branch (`origin/<resolveBaseBranch(config)>` — `workflow.baseBranch`, else the auto-detected default; `origin/main` by default), never a hardcoded `origin/main`: a repo whose base is e.g. `release-x` excludes against `origin/release-x`, so a stale `origin/main` cannot exclude files that still differ from the true base and permit an unsafe carry. It stays two-dot, never three-dot, and never the absolute `merge-base(base,B)...B` PR diff: a two-dot `A..B` never omits a file that differs between A and B (so a divergent non-fast-forward advance cannot carry an angle whose surface changed), and keeping the delta INCREMENTAL means an angle untouched *since head A* stays carried even when the PR touched it in an earlier round (the absolute PR diff would re-review every angle the PR ever touched, carrying nothing). The base-relative exclusion drops files a base-move only INTEGRATES from already-merged base commits: on a base-move re-gate that merges the base branch to resolve a conflict, those files are byte-identical to the base (already reviewed) and contribute NO touched surface, so every eligible angle — and the Copilot convergence carry — carries forward instead of deadlocking against the Copilot round cap. The same exclusion is applied at the OPERATIONAL Copilot round-cap path (`request-copilot-review.mjs`): the post-convergence carry reduces the delta-since-last-review by the PR's base branch and passes `deltaComplete`, so an integrate-only base-move is suppressed there too rather than forcing a fresh round. Fail-closed is preserved: a genuine new PR-own commit whose head content differs from the base still forces re-review, and when the base branch does not resolve the exclusion is skipped (the delta falls back to plain `A..B` and an empty delta still fails closed). Renames that a base-move only replays from the base are excluded too, so they do not force the RENAME_ONLY angles to re-run.

**Feeding the plan into the Phase 1 dispatch preflight (issue #1635).** After carry resolution, a conductor MAY explicitly rebuild the new-head context with `write-gate-context.mjs --carried-angles <json>` using `plan.carried[].angle`. Phase 1 ran before Phase 1.2, so its existing artifact cannot reflect carry until rebuilt; see Phase 3's dispatch-count rule. Both this writer and `consolidate-fanin.mjs` accept an array of angle-name strings, but their flags serve different purposes:

- The context writer narrows `fanout.preflight.requiredReviewers` / `pendingGroups`, never the ledger. It takes no proof argument: the caller MUST use the resolver's proven result. It refuses configured mandatory and hardcoded `ALWAYS_INCLUDE` angles (exit 1), but does not reject unmapped names.
- Fan-in requires `--carry-forward-plan` as independent proof before upserting the prior verdict and findings. Its Phase 3 proof checks also reject unmapped names.

**Threading disposition memory into the same rebuild (issue 2175).** On ANY head-bump re-gate rebuild of the Phase 1 context artifact where at least one angle re-runs, the conductor SHOULD also pass `--prev-head <A>` (the prior round's durable findings-log head) in that same `write-gate-context.mjs` invocation, so every re-running reviewer's briefing carries the prior round's `reject`/`defer` dispositions forward (see "Disposition memory into a re-running reviewer's briefing" above for the mechanics and fail-open guarantee). This is not limited to the partial-carry rebuild above (`--carried-angles` naming at least one carried angle): it also applies to the FULL-fallback outcome of the same carry-forward seam, where ambiguity or a fail-closed default (see below) forces `carried: []` and every angle re-runs — that rebuild still SHOULD pass `--prev-head <A>` even though it has no `--carried-angles` worth passing, so the disposition hint is not silently lost on the very rounds most likely to re-litigate settled findings.

**Review-surface mapping.** An angle's review surface is the set of file "surface kinds" whose change could implicate it, derived from the single source of truth for change-category → angle relevance (`CATEGORY_ANGLE_MAP`) via each file's `classifyFile` kind (`code` | `docs` | `config` | `test` | `ci`):

- code-correctness angles whose surface excludes `docs` (`scope`, `correctness`, `coverage`, `determinism`, …) → their surfaces are derived per angle from `CATEGORY_ANGLE_MAP` and vary (e.g. `scope` → `code`/`config`/`ci`; `coverage`/`determinism` → `code`/`test`); across the group the surface kinds union to `code`/`test`/`config`/`ci` but exclude `docs`, so a pure doc delta touches none of them and they carry forward.
- doc-inclusive angles (`docs`, `link-check`, `contract-surface`, `dry`) → surface includes `docs` (they are all in `CATEGORY_ANGLE_MAP[DOCS_ONLY]`); a pure doc delta re-runs them. `contract-surface` and `dry` therefore do NOT carry forward on a doc-only delta.
- `config-drift` → `config`/`ci`; `ci-guard` → `ci`.
- always-run angles (`gate-evidence`, `pr-description`, `renderer-security`, and any configured mandatory angle) → **never carried** (their surface includes inputs the file delta cannot bound, e.g. the PR body).

**Fail-closed defaults (carry forward = false unless proven safe).** Must-re-run whenever: the prior verdict is neither `clean` nor `findings_present`; the prior findings-log is missing / not carry-forward-eligible; the delta is unavailable, or empty without proof it is complete (an empty delta carries every eligible angle ONLY when the main-relative reduction provably ran — an integrate-only base-move — signalled by `deltaComplete`; an unreduced or non-array delta still fails closed); any changed file is unclassifiable (`unknown` kind); the angle has no declared surface (unmapped); the angle is a configured mandatory angle (the CLI loads the gate's angle entries with `mandatory: true` and forces every one to re-run, never carried); a finding attributed to the angle matches MORE THAN ONE `provenance.perAngle` row (ambiguous attribution — e.g. a base angle plus its `-delta-at-...` re-review sibling, or a case-drifted duplicate — makes it impossible to say which row actually owns the finding, so the angle re-runs regardless of surface); or any changed file's kind is in the angle's surface. The CLI additionally refuses to emit a plan at all — the whole run, not one angle — when: the prior log records one angle twice in `provenance.perAngle` (reviewer attribution would be ambiguous); the log's own recorded `headSha` disagrees with `--prev-head` (the log path and the diffed head would no longer agree, so a carried entry would stamp a head that was never diffed); the log's `findings` field is present but not an array (a malformed/truncated log cannot prove no angle has an open finding); a finding in that field has no angle (it cannot be attributed to a carried angle); or a finding's angle matches no `provenance.perAngle` entry (its attribution cannot be verified, base-name/case-insensitively). The delta and the worktree-head guard both run with `GIT_DIR`/`GIT_WORK_TREE` scrubbed from the git child-process environment, so an inherited repo pointer can never steer either to a different repository than the worktree at `cwd`.

**A dev-loop config-source delta re-runs EVERY angle.** `.devloops` (and its
`.devloops.yaml/.yml/.json` and `.pi/dev-loop/defaults.*` siblings)
defines the gate's angle pool, mandatory floor, and reviewer personas/prompts —
a clean verdict produced under the OLD config has no valid provenance across a
change to it, regardless of the angle's declared surface. `classifyFile`
correctly reports these files as `config`; the carry-forward seam overrides
that via `isDevLoopConfigSourcePath` and forces a full re-run (fail-closed).

**Renames force the RENAME_ONLY angles to re-run.** A rename records only its destination path, so classifying that path alone would miss what the move itself implicates (a relocated doc breaking a link, a moved test/code file shifting scope/contract-surface). When the base-relative delta (above) contains ANY rename/copy row that SURVIVES the base-branch exclusion (a PR-own rename, not one a base-move only replayed from the base), the CLI forces the RENAME_ONLY-mapped angles (`CATEGORY_ANGLE_MAP[RENAME_ONLY]`: `scope`, `correctness`, `contract-surface`, `docs`, `link-check`) to re-run for that run; the remaining angles still follow the surface rule above.

**Provenance — carried, not fabricated.** A carried verdict preserves the fail-closed evidence contract. The new head's findings-log records the carried angle in `provenance.perAngle` with `carriedFromHead: <A>` and the SAME `reviewer` identity that reviewed it at head A (honest attribution — that reviewer genuinely reviewed this angle's surface, which the delta did not change). The ledger also records `provenance.perAngle[].carriedVerdict` (`clean`|`findings_present`, requires `carriedFromHead`) so the record distinguishes a findings-present carry from a clean one at a glance; a findings-present carry preserves its prior findings unchanged, not converted into an approval. `distinctReviewers` still counts real reviewer identities and the mandatory-angle / distinct-reviewer consistency checks in `write-gate-findings-log.mjs` are unchanged; carry-forward never invents a reviewer or a fresh review.

## Exit conditions

Each gate chain exits when one of these conditions is met:

| Condition | Result |
|---|---|
| Consolidated verdict is `clean` (no findings at any blocking severity) | Gate passes; proceed to next boundary |
| `pre_approval_gate` checkpoint `blocked` composed from a deterministic AC/DoD blocker over a completed review ledger (the comment records a **Review verdict** and **Gate blockers**) | Tick verified items or finish the open work, then rerun the gate (the writer's next action is "rerun gate") |
| `blocked` verdict from the review/fan-in itself (gate could not complete) | Stop; escalate to operator |
| Maximum retry cycles exhausted without reaching `clean` | Stop; escalate to operator |
| Fix cycle produces no net progress (same findings after fix attempt) | Stop; escalate to operator |

## Copilot round-cap interplay

The gate chain can complete cleanly at a head that was accepted via round-cap fallback.
By default (converged-once, ADR 0090), a converged latest Copilot review stands for later
heads whatever the delta: the loop opens no new Copilot cycle, and `pre_approval_gate`
reviews the current head. The request tool returns `suppressed_post_convergence` below the
cap, at the cap, and under `--force-rerequest-review`, and merge grants `converged_once`.
With `refinement.requireCopilotConvergenceAtLatestHead: true` (strict mode), the
post-convergence carve-out applies: significant post-convergence changes on a newer head
open a new Copilot cycle that requires another round before pre-approval. Both modes are
owned by `COPILOT-FOLLOWUP-ROUND-CAP` in [Copilot PR Follow-up](../copilot-pr-followup/SKILL.md)
and `COPILOT-STATE-CARRIED-CONVERGENCE` in [Copilot Loop State Graph](copilot-loop-state-graph.md).
The seam below is the strict-mode carry.

**Convergence carry-forward decision seam (fail-closed, AC2).** A pure doc/prose head bump
after convergence should not need to re-open a blocking Copilot cycle.
`resolveConvergenceCarryForward` (`@dev-loops/core/loop/gate-carry-forward`, also surfaced as
the `copilotConvergence` field of `resolve-angle-carry-forward.mjs`) computes that decision:
`carryForward: true` when the delta since the converged head touches none of Copilot's
review surface (every changed file classifies as `docs`), and fail-closed `false` on any
code/test/config/CI file, an unclassifiable file, or an unavailable delta. On the
`resolve-angle-carry-forward.mjs` path the same main-relative delta basis applies (issue #2292): an
integrate-only base-move (proven-empty reduced delta, `deltaComplete`) carries the convergence
forward too, instead of forcing a fresh blocking round for already-merged main code. An empty
delta WITHOUT that proof still fails closed. The Copilot request tool (at and below the
round cap) and the gate coordination detector consume it through the one shared
carried-convergence predicate owned by `COPILOT-STATE-CARRIED-CONVERGENCE` in
[Copilot Loop State Graph](copilot-loop-state-graph.md): the request tool never
re-requests on a head the detector reports as carried (`postConvergenceReviewSuppressed`,
which allows `pre_approval_gate`), and the detector never reports carried on a head where
the request tool would re-request. On a carried head the request tool returns
`suppressed_post_convergence_docs_only` below the cap and at the cap under
`--force-rerequest-review`; at the cap without that flag it returns `round_cap_reached`. An unresolved review thread, a non-linear (rebased/amended) advance, any
rename/copy, an unavailable compare, or any non-doc/unclassifiable file re-opens the round,
preserving the round cap and the significant-post-convergence-change exception
(`COPILOT-FOLLOWUP-ROUND-CAP` in [Copilot PR Follow-up](../copilot-pr-followup/SKILL.md)).

## Machine-parseable fields

The sub-loop execution shape can be referenced programmatically via these fields:

| Field | Value | Description |
|---|---|---|
| `subLoopPhases` | `[preamble, fanout, fanin, fix, repeat]` | Ordered sub-loop phases |
| `contextBuilderRequired` | `true` | Preamble phase must include fresh-context context-builder |
| `worktreeIsolationProhibited` | `true` | Per-angle reviewers must run in the PR's actual worktree/head, never an isolated worktree (#1135) |
| `fixRetryUntilClean` | `true` | Blocking-severity findings trigger fix → retry until synthesis is clean |
| `separateChains` | `true` | Each gate runs an independent chain with its own disposition ledger |

## Gate-specific configuration

Only the review angles and blocking severity policy differ per gate:

| Gate | Review angles | Blocking severities | Owned by |
|---|---|---|---|
| `draft_gate` | Resolved from config (`resolveGateAngles(config, "draft")`) | Resolved from config (`resolveGateConfig(config, "draft").blockCleanOnFindingSeverities`) | [Copilot PR Follow-up Skill](../copilot-pr-followup/SKILL.md) |
| `pre_approval_gate` | Resolved from config (`resolveGateAngles(config, "preApproval")`) | Resolved from config (`resolveGateConfig(config, "preApproval").blockCleanOnFindingSeverities`) | [Copilot PR Follow-up Skill](../copilot-pr-followup/SKILL.md) |

## Non-substitution rule

<!-- rule: GATE-EXEC-NON-SUBSTITUTION -->
`GATE-EXEC-NON-SUBSTITUTION`: A clean sub-loop pass for one gate does not satisfy the other gate.
Each gate MUST run its own complete sub-loop execution (`GATE-EXEC-SEPARATE-CHAINS`) with
its own visible checkpoint verdict comment on the PR for the reviewed head SHA.

## Disposition ledger and durable logging

<!-- rule: GATE-EXEC-DISPOSITION-LEDGER -->
`GATE-EXEC-DISPOSITION-LEDGER`: Every gate pass MUST write a durable final-findings log
via `write-gate-findings-log.mjs` **before** the visible PR comment is posted; the ledger
is the durable record of what the gate found and what was decided, and the visible
comment is a summary for auditability, not a replacement for it.

```sh
node scripts/github/write-gate-findings-log.mjs \
  --repo <owner/name> \
  --pr <number> \
  --gate <draft_gate|pre_approval_gate> \
  --head-sha <sha> \
  --verdict <clean|findings_present|blocked> \
  --spec-authority <identity-path> \
  --emit-plan <emit-plan-path> \
  --provenance <json> \
  --execution-mode fanout_fanin \
  --findings-file <path>   # or inline: --findings '[{"severity":"high","angle":"scope","summary":"...","files":["path.mjs"],"line":42,"disposition":"accepted-for-fix"}]'
```

The conductor's fan-out round passes `--execution-mode fanout_fanin` on this call, activating the CLI's own write-time provenance fail-closed guard (distinct from `detect-checkpoint-evidence.mjs`'s read-time `requireFanoutProvenance` check described above).

`--findings-file` reads the same JSON from a file (identical validation) —
use it for any non-trivial ledger so the array never rides a shell string;
`post-gate-findings.mjs` accepts the same flag. The `consolidate-fanin` CLI's
`--ledger-out <path>` writes a `{ overallVerdict, findings }` wrapper — pass
that path straight to `--findings-file` on both tools, no hand extraction.
The sanctioned fan-out path also passes the emitter's keyed plan to this write
via `--emit-plan`; the option remains additive for legacy/inline callers, but
when present it requires `--provenance` and applies the correspondence guard
owned by `GATE-EXEC-EMIT-PLAN-KEY` above.
`write-gate-findings-log.mjs` threads the wrapper's `overallVerdict` (the
consolidator's computed verdict) into the durable ledger, so
`upsert-checkpoint-verdict.mjs` enforces verdict consistency against it (#1616,
`GATE-COMMENT-VERDICT-VALUES`): a `--verdict` that contradicts the ledger's
`overallVerdict` is refused, and when the ledger carries `overallVerdict` the
verdict is derived from it by default (passing no `--verdict` is valid).
`write-gate-findings-log.mjs` itself fails closed the same way at write
time: when the `--findings`/`--findings-file` wrapper carries `overallVerdict`,
a caller-passed `--verdict` that contradicts it is refused before any ledger
is written, so a contradicting pair never reaches the durable log in the first
place. This write-time comparison is always against the wrapper's
`overallVerdict` — the consolidator's computed round verdict — whether or not
`--judge-verdict` (above, Phase 3.5) is also supplied on the same call: the judge only
enriches findings with `act`/`defer`/`reject` dispositions and never revises
the round verdict, so its presence does not change what `--verdict` is
checked against.
`post-gate-findings.mjs` unwraps and ignores `overallVerdict`. A finding with severity
`low` or `nit` (or a legacy spelling, normalized on read) and no
`disposition` gets `deferred` derived automatically by both tools. A
`question` finding with no `disposition` is derived the same way: `needs-answer`
when the finding is locatable (names an in-diff `file:line`), `deferred`
otherwise. `write-gate-findings-log.mjs`'s entry shape can carry `line`, so it
can reach `needs-answer`; `post-gate-findings.mjs`'s entry shape never
carries `line`, so a question there always resolves `deferred`.

The log is written under `tmp/gate-findings/<repo-slug>/pr-<N>/<gate>-<headSha>.json`.
Each log entry records the full disposition: severity, angle, summary, affected files, optional
1-based `line` (drives inline-vs-body-filed placement in `GATE-EXEC-FINDING-THREADS` below), and
resolved-in SHA (for findings resolved in a later pass).

### Finding threads and disposition

<!-- rule: GATE-EXEC-FINDING-THREADS -->
`GATE-EXEC-FINDING-THREADS`: A gate round has exactly ONE visible surface: the PR review of type
COMMENT that `upsert-checkpoint-verdict.mjs` posts. Pass that round's ledger to it via
`--findings-ledger <path>` — the same durable log `write-gate-findings-log.mjs` just wrote — and
the verdict body and the round's findings land together on that one review, split into TWO TRACKS
by locatability (`GATE-COMMENT-SINGLE-SURFACE`, #1942): a **locatable** finding (an in-diff
`file:line`) becomes an inline comment on that review, and its full text lives ENTIRELY there —
the body never restates or per-row references it, only a single aggregate `**Inline findings:**`
line (count, severity breakdown, touched angle names) pointing at the inline comments. A
**non-locatable** ("body-filed") finding has no inline carrier, so it renders in full as its own
plain bulleted list item in the body (never a table row) — summary, `file:line` blob-linked when
known, and its angle in trailing brackets. A finding's full text therefore lives in EXACTLY ONE
reader-reachable carrier, never both and never neither. A finding's own free text can never be
mistaken for a genuine gate verdict field by the line-start `gate:`/`head sha:`/`verdict:`/
`summary:` structured field parser: each body-list item runs through the same sanitizer the rest
of the structured render uses (neutralizing markdown/HTML forgery and collapsing any embedded
newline to a space), so no finding's text can ever reach column 0 of its own logical line. A
non-locatable finding additionally stamps one INVISIBLE fingerprint+disposition marker (below) on
the review body — this marker, never the finding's visible text, is what cross-round suppression
and deferral tracking read back; the per-angle breakdown does NOT degrade to an
`angle → verdict (+ finding count)` one-liner just because a round also carries
`--findings-ledger`.

A finding anchored to unchanged code has no in-diff `file:line` and is therefore always
body-filed, tracked through the disposition ledger and its fingerprint rather than a review
thread; the thread-based force-fix guarantee `GATE-EXEC-THREAD-DISPOSITION` describes applies to
locatable findings only — a body-filed finding at any non-`high` severity is instead deferred
by construction, stamped `disposition=deferred` at the round it is first posted. Every posted
finding, inline or body-filed, carries a fingerprint marker on its first line (`<!--
dev-loops:finding <fp16> severity=<s> angle=<a> round=<n>[ disposition=deferred] -->`), and the
review body carries a `<!-- dev-loops:gate-findings-review <gate> <headSha> round=<n> -->` header
marker recording which round of THIS gate it is. That marker alone would flag the body as a
machine-authored gate artifact and hide it from the checkpoint-evidence scanner
(`detect-checkpoint-evidence.mjs`, via the shared `summarizeGateReviewComments`/
`summarizeGateReviewCommentMarkers` helpers every gate-evidence reader calls through); the
producer-owned verdict header (`### Gate review: \`<gate>\``) on the same body overrides that, so
the round's single surface stays readable AS the verdict. Only a marker-bearing body with no
genuine verdict header — a historical standalone findings review, the batched deferral
comment (`<!-- dev-loops:deferred-summary -->`, `GATE-EXEC-DEFERRAL-RECORD`), or the current opt-in findings comment
(`dev-loops:gate-findings gate=`, `GATE-COMMENT-IDENTITY-DISJOINT`) — stays excluded and can
never win the newest-gate-marker tie-break over a real verdict.

(#2263) `GATE-COMMENT-INLINE-SEVERITY-FLOOR` (owned by
[Checkpoint Verdict Comment Contract](./gate-review-comment-contract.md)) applies BEFORE the
locatability split above: a finding ranked below the gate's `inlineSeverityFloor` (default
`medium`, so `low`/`nit` by default) never reaches either the inline or body-filed track — it
folds into the verdict body's own collapsed `<details>` section instead, regardless of
locatability, carrying the same fingerprint+`disposition=deferred` marker shape a body-filed
finding carries. A folded finding creates NO review thread, so it never enters
`unresolvedGateThreadCount` below.

Before posting, a candidate finding is dropped when its fingerprint already matches an
OWN-AUTHORED (the authenticated `gh` viewer's own login) existing thread or review body on the
PR, resolved threads included — a foreign review/thread quoting or forging the same marker shape
never suppresses a real finding, since folding a fingerprint someone else could freely paste in
would be a forgery vector, not a provenance check; cross-author suppression (recognizing a finding
a foreign commenter has ALREADY discussed) is instead carried by the reviewer briefing's second,
prose suppression layer described below. Suppression is binding across every round of a gate's
chain AND across both gates, so a draft-gate deferral is never re-raised at pre-approval. On a
same-head rerun the existing review's BODY is corrected in place (GitHub exposes no endpoint to
add inline comments to a submitted review), so every still-unposted finding is body-filed on that
correction rather than dropped.

After the verdict post AND after the Phase 5 (Retry) fixer triage pass, at every gate close, run
`close-gate-findings.mjs --ledger <path> --allowed-refs <governing-issue>` against that same ledger
(`<governing-issue>` = the PR's governing/closing issue, resolved deterministically from
`closingIssuesReferences` — never hardcoded; see the copilot-pr-followup SKILL step 7 for the
resolution + scoped-allowlist rationale). It posts NOTHING of its own —
it runs only the thread disposition pass (`GATE-EXEC-THREAD-DISPOSITION`). The defer-close for
low findings runs AFTER the fixer triages them (#1585): the fixer sees every gate-authored
finding first (fix-if-cheap-in-the-same-commit, else defer), then the disposition pass acts as
the closing sweep — stamping `disposition=deferred` for threads the fixer chose to defer and
REPORTING `unresolvedGateThreadCount` (gate-authored threads still unresolved after the defer
and reject-close passes). The actual gate-close assertion is performed by the downstream callers
(`fetchDraftGateEvidence` / `ready-for-review.mjs` / `pre-pr-ready-gate.mjs`, the
`draftGateSatisfied` fold in `detect-checkpoint-evidence.mjs`, and the `draftGate.currentHeadClean`
fold in `detect-pr-gate-coordination-state.mjs`) on a non-zero count — the
disposition pass does not assert the gate-close decision itself; it only REPORTS
`unresolvedGateThreadCount` (its return always uses `ok:true`). It may still throw on gh or
resolve failures inside the defer sweep, which the conductor must treat as a failed gate-close
sweep (re-run); only the gate-close *decision* is not its role, so its role and the gate-close
assertion's role stay distinct.
`GATE-EXEC-POST-BEFORE-FIX` (findings visible on the PR before fixes) is unaffected: only the
defer-close timing moves to post-fix. That pass runs independently of
`gates.postFindingsComments`: that toggle governs only the opt-in consolidated
`GATE-EXEC-POST-BEFORE-FIX` comment. The reviewer briefing's second, prose suppression layer is
owned by the
[fan-out procedure](../copilot-pr-followup/SKILL.md#gate-fan-outfan-in-procedure-agent-orchestrated):
the context builder renders a known-findings block from `write-gate-context.mjs --known-findings`
(`capture-review-threads.mjs` output) into the round-bound `<gate>-<headSha>.known-findings.json`
and hash-binds it as a required read when at least one thread exists. The block stays outside the
byte-identical prefix `GATE-EXEC-BRIEFING-PREFIX` hashes. The snapshot is build-time: a
`--same-head-retry` replays it, and a retry that must see threads posted after the build uses
`GATE-EXEC-ROUND-RETIREMENT` (retire, then rebuild). The conductor
relays each work order's `promptPath` bytes unchanged and never appends anything after them.

<!-- rule: GATE-EXEC-THREAD-DISPOSITION -->
`GATE-EXEC-THREAD-DISPOSITION`: A gate-authored thread's severity decides how it closes. A
high thread stays unresolved until the standard fix, reply-with-resolving-commit, resolve
loop (Step 7 of [Copilot PR Follow-up](../copilot-pr-followup/SKILL.md)) closes it — no other
exit exists. High-if-present is the per-gate continuation default: an open high finding
forces another fix round for that gate, and an unfixable high finding escalates to the operator via
the existing gate round cap (`roundCapReached` in `packages/core/src/loop/pr-gate-coordination.mjs`)
plus the "Maximum retry cycles exhausted → escalate to operator" rule — never deferred (high
is exempt from the medium window). A medium thread stays unresolved and goes
through that SAME loop through this gate's configured medium fix window (default 3,
`gates.<gate>.mediumFixWindow`; #1581) of this gate's chain; from the next round on (round 4
under the default window), an open medium thread is instead
replied to and resolved by `close-gate-findings.mjs` itself, which stamps
`disposition=deferred` onto the thread's marker first so the deferral record
(`GATE-EXEC-DEFERRAL-RECORD`) tells a deferred thread apart from one the fix loop genuinely
resolved. A low finding is a fixer TRIAGE target, not a silent auto-defer (#1585): the
fixer receives it as a fix/triage target alongside high and medium, and may
fix-if-cheap-in-the-same-commit (free polish when already touching that code) or defer. Defer is
permitted from round 1 on for low findings — no forced fix window — except a low the judge
disposed `act`, which is a fix target declinable only on reproduction grounds
(`GATE-EXEC-JUDGE-AUTHORITY-SPLIT`), never re-deferred on its severity label. A low finding the fixer
defers is still reply+resolved via an explicit fixer triage decision by the disposition pass
(`close-gate-findings.mjs`), which runs AFTER the fixer triage — not a silent post-hoc pass that
can skip threads. Whether that reply+resolve ALSO stamps `disposition=deferred` and files the
finding onto the round's deferral comment is a SEPARATE, further-gated decision (#1846,
net-reduction disposition policy): a low is filed only when its own marker carries the explicit
`operatorVisible` signal (the finding's own `operatorVisible: true`, set by its producer — see
`buildFindingMarker` in `_gate-finding-surface.mjs` for the full contract); the DEFAULT (absent or
`false`) is NOT operator visible, so the thread is still resolved-with-rationale by the
disposition pass, just never filed or stamped `disposition=deferred`. This governs the
severity-axis disposition only — distinct from the judge's own relevance-axis defer bar (Phase
3.5 above), which uses "operator-visible outcome" language for the same conservative-default
intent on a different axis. A question thread is never deferred: the
fixer replies with an answer (promoting the finding to a defect severity when the answer reveals
one, or escalating to the author when the fixer cannot answer it) and resolves the thread once
answered; an unanswered question stays unresolved through the same round cap/escalation path a
high finding uses, since `isDeferredAtRound` never selects it for auto-deferral (mechanically
enforced and tested). Which of the three replies a fixer sends — a plain answer, a
promoting-to-defect-severity answer, or an escalation to the author — is a per-thread fixer
judgment call, not a state machine this codebase drives or unit-tests; only the
never-auto-deferred invariant above is. ONE reject-close exception (ADR 0088): a
question the judge disposed `reject` never reaches the fixer's act list, so the fixer's own
answer-and-resolve path above never runs for it — once the thread carries a resolving answer
reply, `close-gate-findings.mjs` closes it directly, citing the judge's rejection rationale in
the reply. A resolving answer reply is identified by WHAT IT IS, never by WHO POSTED IT (a
non-empty, non-bot, non-System/ghost comment that is not the gate's own automation output and
does not contain an unescaped `@copilot`/`/copilot*` summon anywhere in its body): a
single-account setup can post the finding and every reply under the same authenticated login,
so "posted by someone other than the gate" is never the criterion. A reply that mixes a real
answer with a summon is still excluded — post the answer and the re-review summon as separate
replies. This is still a reply-and-resolve, never a
`disposition=deferred` stamp, and a question is still never fileable; an unanswered question, or
one the judge disposed `act`/`defer`, is untouched by this exception and still follows the paths
above. A nit thread is
resolved-with-rationale immediately at round 1 by `close-gate-findings.mjs` — the fixer owes it no
triage cycle (unlike low, it is not handed to the fixer as a fix/triage target on the severity
axis; the one exception is a judge `act` on a nit, which reaches the fixer through judge-pass's
severity-blind act filter); the closing sweep resolves a still-unresolved nit thread the judge did
not dispose `act`, regardless of whether the fixer looked at it. A nit is NEVER filed to the deferral comment and NEVER stamped
`disposition=deferred` (#1846, net-reduction disposition policy) — its resolving reply names the
rationale in-thread and nothing more; this is unconditional, unlike the low gate above, which at
least has an opt-in path. Every resolve-without-fix reply the disposition pass posts for a low,
medium, or nit MUST carry an explicit `Examined on merits:` rationale that names the finding
summary and the applicable scope, acceptance-criteria, fix-window, or filing-bar basis (#1882): a
severity-or-round-eligibility label is never itself sufficient merit for closure. `close-gate-findings.mjs`
builds that rationale from the thread's rendered finding summary and fails closed on any target
whose summary cannot be parsed — recording it in `dispositionFailures` and leaving the thread
unresolved (which keeps `unresolvedGateThreadCount` non-zero) rather than emitting a severity-only
note or, worse, a stamped-but-unresolved thread. GATE-CLOSE requires 0 unresolved
gate-authored threads: `draftGateSatisfied` / `ready-for-review` / `pre-pr-ready-gate` assert
that every gate-authored review thread (any severity: high, medium, low,
question, OR nit) is resolved before the gate is considered satisfied and before `ready-for-review`
— a clean verdict alone no longer satisfies the gate. The fixer triages EVERY gate-authored
defect finding (high, medium, AND low) on EVERY gate round (clean verdict or
not): fix-if-cheap-in-the-same-commit, else defer — defer is permitted from round 1 on for
low findings (#1585), except a low the judge disposed `act`, which is a fix target declinable
only on reproduction grounds (`GATE-EXEC-JUDGE-AUTHORITY-SPLIT`) — and answers every gate-authored question. Fix-close is the fixer's role; the disposition pass
(`close-gate-findings`) then resolves every still-open DEFERRABLE gate-authored thread
(low, nit, and out-of-window medium) as the closing sweep AFTER the fixer's
triage — it never fix-closes, and it deliberately leaves high, question (except an
answered, judge-rejected question, which it reject-closes per ADR 0088), and in-window
medium threads unresolved (they keep `unresolvedGateThreadCount` non-zero, which
blocks gate close until the fixer/fix-loop resolves them). The disposition pass never selects a
thread whose finding the judge disposed `act`, whatever its severity and round (ADR 0089). The
current round's ledger decides first. When it has no finding with the thread's fingerprint (a
posted finding is suppressed from later ledgers), the prior local ledgers decide, then the
thread's rendered ` — judge: <disposition>` suffix. An ambiguous result at either ledger tier
also skips the thread (fail closed): current-ledger entries with the thread's fingerprint whose
dispositions disagree (mixed or partly missing), or prior ledgers that disagree. The judge `act` overrides the medium fix window, so that thread gets no stamp,
no reply, no resolve, and no deferral comment entry, and it stays open until the fixer closes it
with a fixing commit or a decline reason, or a judge rerun at the current head changes the disposition. The fixer
replies to every gate thread whose finding it fixed or declined on reproduction grounds, of any severity and including a judge `act`
item past the medium fix window, with the fixing commit or a decline reason, and resolves it before
`close-gate-findings.mjs` runs. Resolving and FILING (to the round's deferral comment, stamping
`disposition=deferred`) are two separate decisions (#1846): out-of-window
medium always files; a low files only when operator-visible; a nit never files — the unfiled
subset is still resolved-with-rationale, so `unresolvedGateThreadCount` reaches 0 either way. A
thread left unresolved after the
sweep fails the gate closed (not silently satisfied); a low finding the fixer did not fix is
resolved by the sweep (the fixer had its chance first), never a silent pre-fixer auto-defer. Because an unresolved review thread routes the PR to the
`unresolved_feedback_present` state ([Copilot Loop State Graph](./copilot-loop-state-graph.md))
and forbids the next pre-approval gate action, an in-window
medium thread forces a fix round even after the current round's severity set is
otherwise clean — this is the existing unresolved-feedback routing, not a new enforcement path.
A finding the fixer rejects under its triage authority is not left dangling: it is closed with
an explicit dispute reply and resolved, and its fingerprint keeps it suppressed, so no
gate-authored thread can deadlock the chain. Distinctness differs by what closed the thread: a
FIX-closing reply (the standard fix loop, or a dispute reply) follows
`COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER` and names the specific change that fixed that thread,
with the resolving commit — nothing was fixed for a thread the fix loop never touched, so this
requirement cannot apply verbatim there. An ANSWER reply to a question names the answer (and, when
the answer promotes the finding, the new severity and follow-up thread it becomes). A DEFERRAL
reply (`close-gate-findings.mjs` past the
medium window, or an operator-visible low the fixer triaged and chose to defer via
the post-fixer disposition sweep (#1585)) is instead distinct by
construction through the marker fields it stamps on the thread (fingerprint, severity, angle,
round) and states the window/disposition reason (see `dispositionMessage` in
`close-gate-findings.mjs`). A RESOLVED-NOT-FILED reply (a nit, or a low the fixer triaged with no
operator-visibility signal; #1846) is distinct again — it names the net-reduction disposition
policy rationale instead of a deferral comment link, and stamps no `disposition=deferred` (see
`unfiledResolutionMessage` in `close-gate-findings.mjs`). Either way, a shared body across multiple threads is permitted only
when one named shared root cause genuinely closed them all.

<!-- rule: GATE-EXEC-FIXER-DISPOSITION-BOUNDARY -->
`GATE-EXEC-FIXER-DISPOSITION-BOUNDARY`: After every fixer push, each review thread marked
`disposition: "tackled"` in its handoff MUST, in order, have a recorded `threadId` and
fixing commit SHA, verified containment by the observed PR head, a reply evidencing that
commit, resolution, and a live re-read confirming resolution. A finding fingerprint may
accompany the required thread id; it does not replace it. This per-fixer boundary precedes
the next review/gate round; `GATE-EXEC-THREAD-DISPOSITION` still governs eventual closure.

`normalizeFixerDispositionHandoff` (`packages/core/src/loop/fixer-disposition.mjs`) rejects
missing `threadId`/`fixingCommitSha`/`disposition` and duplicate thread ids/fingerprints.
`isCommitContainedByHead` (`scripts/github/_commit-containment.mjs`) accepts only `gh compare`
`identical`/`ahead`; `behind`/`diverged`, API errors and missing evidence fail closed.
A SHA alone, a wrong-branch, superseded or uncontained SHA, or an outdated diff location
never authorizes resolution. The pure `evaluateFixerDisposition` consumes injected live
thread/containment facts identically across Pi, Claude Code and Codex, with no GitHub/git I/O.
It reports one `failedStep` per incomplete thread: `missing_from_handoff`,
`commit_not_contained`, `reply_missing`, or `not_resolved`.

While any tackled thread is incomplete, `FIXER_DISPOSITION_FORBIDDEN_ACTIONS` also forbids
Copilot request/re-request and every gate dispatch, beyond `pr-gate-coordination.mjs`'s
`postDraftForbidden`. A zero `unresolvedThreadCount` cannot waive this boundary.
`fixerDisposition: { complete, incomplete }`, when present and incomplete, forces blocked
`feedback_resolution` ahead of every lifecycle branch, naming the thread, expected commit,
failed step and sole next action `complete_fixer_disposition`. Untackled, deferred, rejected,
foreign-authored and newly arrived threads keep their existing judgment path; this boundary
never auto-resolves outside the tackled set.

`scripts/github/verify-fixer-disposition.mjs` loads/records
`tmp/gate-findings/<repo-slug>/pr-<N>/fixer-disposition-<headSha>.json`, captures live state,
checks containment and evaluates. Only after containment passes may it post the evidenced
reply and resolve; if a matching reply already exists, it resolves without reposting. Live
checks precede writes, so restart, rate limit, timeout and reply-success/resolve-failure
re-entry cannot duplicate replies. `scripts/loop/detect-pr-gate-coordination-state.mjs`
feeds this evaluation into coordination. Without a current-head checkpoint, existing
behavior is unchanged.

<!-- rule: GATE-EXEC-DEFERRAL-RECORD -->
`GATE-EXEC-DEFERRAL-RECORD`: A deferred finding's record lives in up to THREE places, with no summary comment beyond the
one batched deferral comment: the finding's own posted surface — the resolving reply on
its thread for a locatable finding, or its body-filed entry on the round's review for a
non-locatable one — the durable findings-log ledger under `tmp/gate-findings/...`, and ONE batched
deferral comment per tool run on the comment target (at most one from `judge-pass.mjs` and one
from `close-gate-findings.mjs` in a round), the durable record that survives a `tmp/` wipe. The comment target is the PR's linked spec issue when `tracker.provider` resolves to
`github` and the PR has exactly one closing issue reference; otherwise it is the PR itself (no
linked issue, more than one closing reference, or a tracker other than GitHub). No tool creates
an issue for a deferred finding: each of `judge-pass.mjs` and `close-gate-findings.mjs` never
creates an issue and never writes a tracker other than GitHub. The third place — the deferral comment — is
written for every deferral that flows through the disposition pass or the judge defer path (a
locatable thread stamped `disposition=deferred`). The body-filed non-locatable case is the one
disclosed exception (#1807 known limitation): it is stamped and body-filed durably (the first two
places) but is not itself listed in the deferral comment, because that render-time call site has
no GitHub I/O.

A FOLDED finding (#2263, `GATE-COMMENT-INLINE-SEVERITY-FLOOR`) is NOT this disclosed exception.
`close-gate-findings.mjs` recomputes the round's folded findings directly from the ledger (they
carry no thread to select a disposition target from) and applies the exact same net-reduction
filing bar (`isFileableDeferral`) the thread pass uses — an operator-visible `low` (its own
marker's `ov=1`) joins the tool run's ONE deferral comment together with the fileable thread targets;
a `nit` or a non-operator-visible `low` files nothing, on the theory that it is already recorded,
visible, in the folded `<details>` block itself — that IS its resolved-with-rationale record.
A folded finding the current ledger disposes `act`, or holds ambiguously (duplicate-fingerprint
entries whose dispositions disagree), is left out of the deferral comment
(`selectFoldedFileableEntries`).

The posted surface and the ledger both carry the finding marker's optional `disposition=deferred`
field (`<!-- dev-loops:finding <fp16> severity=<s> angle=<a> round=<n>[ ov=1][ disposition=deferred][ issue=<n>] -->`
— `ov=1` is the #1846 operator-visibility signal, present only when the finding's own producer set
`operatorVisible: true`), which is what tells a deferred thread apart from one the fix loop
genuinely resolved with a fixing commit. A THREAD marker is stamped `disposition=deferred`
(and listed in the deferral comment below) only when the disposition pass DEFERS it — a
medium thread past the gate's configured medium fix window
(default 3, round 4 under the default; #1581), or an OPERATOR-VISIBLE low thread (its own marker
carries `ov=1`) the fixer triaged and chose to defer — closed by the post-fixer disposition sweep,
never a silent pre-fixer auto-defer (#1585). A nit is NEVER stamped `disposition=deferred` and
NEVER filed, regardless of round (a nit skips the fixer on the severity axis, judge-acted nits
excepted); a low the fixer triaged and chose to defer that carries no `ov=1` signal is likewise
resolved-with-rationale but NOT stamped or filed — the conservative, net-negative-backlog default
(#1846, net-reduction disposition policy). A question thread is never stamped `disposition=deferred` — it is answered, not
deferred; its resolution is the answer reply itself. A
non-locatable (body-filed) marker is stamped `disposition=deferred` unconditionally, for any
severity other than `high`, at the round it is first posted — permanently deferred by
construction, since a body-filed finding has no code location and so can never become a
resolvable thread through which the standard fix loop could otherwise close it. (The #1846 filing
bar governs the THREAD-based disposition pass only; a body-filed finding's render-time stamp is
unaffected — it is never listed in the deferral comment either way, per the disclosed #1807
exception above.)

A `defer` is never parked ONLY in the thread marker and the ephemeral tmp findings ledger: it is
ALWAYS listed in the round's deferral comment on the comment target. A round's deferred findings —
a newly out-of-window medium, a fixer-triaged operator-visible low, an operator-visible folded low,
or a judge `defer` — go as ONE batched comment per tool run listing each finding's fingerprint/severity/angle;
the tool never creates an issue. Both the thread marker (`issue=<n>`) and the durable ledger entry
(`followUpIssueNumber`) record the target's number (a PR number is a valid comment target) — the
re-attachment pointer that lets a reader recover the record even after the ephemeral ledger is
gone. Idempotency is per fingerprint: before posting, `commentDeferredFindings`
(`scripts/github/_gate-finding-surface.mjs`) reads the target's existing deferral comments (first line
`<!-- dev-loops:deferred-summary -->`; a bullet in any other comment is not counted), and a finding
whose fingerprint the target already lists is not appended again, so a re-run of either pass posts
nothing new. The judge's own bridge (`judge-pass.mjs`) and `close-gate-findings.mjs`'s
severity/round-based defer resolve the same target from the same PR facts, so both paths converge.
The disposition pass never selects a thread whose finding the judge disposed `act` in the current
or a prior round (`GATE-EXEC-THREAD-DISPOSITION`), so an open act thread is never defer-closed.
A `disposition=deferred` thread marker with no linked `issue=<n>` is a `GATE-EXEC-THREAD-DISPOSITION`
contract violation, refused fail-closed exactly like an out-of-window stamp.

A `reject` (the judge's relevance axis only — see Phase 3.5 above) is never a deferral, and
`judge-pass.mjs` writes nothing to the deferral comment for it: it records a one-line audit entry
in the durable ledger (fingerprint, severity, angle, `judgeDisposition: "reject"`, rationale).
`close-gate-findings.mjs`'s severity/round disposition still lists a past-window `medium` or an
operator-visible `low` in the deferral comment, whatever its `reject` disposition.

## Execution mode and fan-out evidence enforcement

Each gate verdict records an `executionMode` (`fanout_fanin` or `inline_single_agent`,
default `inline_single_agent`) via the [Gate comment command](../copilot-pr-followup/SKILL.md#mandatory-gate-comment-command-contract); inline runs must declare an `--inline-reason`. A `fanout_fanin` verdict passes the structured per-angle review results via `--findings-json` (the per-angle `{angle, verdict, findings}` artifacts that feed `consolidateFanin`, or the flat `toFindingsLogShape` output grouped by `.angle`) so the comment renders a per-angle breakdown; `--findings-summary` is the `inline_single_agent` fallback, plus the one `fanout_fanin` exception — a round posted without `--findings-json` (the withheld `consolidate-fanin` case is the motivating one, where `--out` was never written and `--findings-json` would fail closed with ENOENT), which instead proves mandatory-angle coverage from `--findings-ledger`'s provenance and is refused when neither artifact is supplied on a gate with mandatory angles configured — see [Phase 3 — Consolidation](#phase-3--consolidation-fan-in-synthesis-and-disposition-ledger) for the full artifact/coverage rule; not restated here. Fan-out evidence enforcement is **ON by default** (`gates.requireFanoutEvidence`): a clean gate verdict requires the gate to run via `--execution-mode fanout_fanin` with a findings-log ledger for the head SHA. Enforcement runs at **both** boundaries, sharing one acceptance predicate (`evaluateInlineFanoutMode`, `detect-checkpoint-evidence.mjs`) so the two can never drift: the **produce step** (`upsert-checkpoint-verdict.mjs`) refuses to record an under-qualified `inline_single_agent` verdict for a required gate BEFORE it is ever posted — for every verdict value (`clean`, `findings_present`, `blocked`), since mode qualification does not depend on the conclusion — and the **pre-merge evidence check** (`buildPreMergeGateCheck`) remains the fail-closed net for a required gate otherwise (e.g. a verdict posted before enforcement existed, or a hand-edited comment). Repos can opt out with `gates.requireFanoutEvidence: false`; there is no per-post override. Live context-builder/fan-out execution (epic #867) is what makes `fanout_fanin` producible — distinct from this contract's own sub-loop phase numbering (preamble / fanout / fanin).

### Light-mode inline acceptance (under-threshold micro-PRs)

`lightMode` (`localImplementation.lightMode`, #1043) collapses the gate fan-out to a
single `inline_single_agent` check for genuinely small changes. Because
`requireFanoutEvidence` otherwise rejects any non-`fanout_fanin` verdict, both enforcement
boundaries are **light-mode-aware** (#1174) through the one shared predicate: they accept
a required gate's `inline_single_agent` verdict **only** when **all** of the following
hold, and **fail closed** on any one that does not — leaving today's rejection
byte-identical:

- `localImplementation.lightMode.enabled` is `true` in config;
- the reviewed head's scope is **re-derived fail-closed** — at post time against the
  PR's current base ref, and again at merge time — via `detectMergeBaseScope` (the
  three-dot merge-base diff, `git diff <base>...<head>`) and is genuinely under the
  configured `maxFiles`/`maxLines`. This is deliberately NOT the two-dot `detectScope`
  that `resolve-gate-dispatch` uses at dispatch time: re-deriving against the merge base
  means a non-fast-forward advance cannot understate scope. If scope cannot be derived
  (missing base ref, git failure), the inline verdict is rejected;
- the PR carries **no `gate:full` label** (the label always forces the full fan-out —
  scope is not even measured);
- the verdict records a non-empty `--inline-reason`.

<!-- rule: GATE-EXEC-LIGHT-ESCALATION -->
`GATE-EXEC-LIGHT-ESCALATION`: An inline pass surfacing a finding at a blocking severity MUST escalate to the full fan-out — escalation is two-trigger: the `gate:full` label override, and any finding at a severity in the gate's `blockCleanOnFindingSeverities`. The escalation goes to the full fan-out (`resolveGateDispatchMode` returns `mode: "full_fanout"` with `reason: "escalated"`) — the
inline verdict never absorbs a blocking finding. When `lightMode` is enabled without
explicit thresholds, the built-in defaults apply (`maxFiles: 3` / `maxLines: 200`); the
shipped default is `enabled: false`. Light mode changes HOW the gate runs (inline vs
fan-out), never WHETHER the draft boundary exists — `workflow.requireDraftFirst` is
honored regardless.

Evidence retention stays uniform: a light-accepted inline verdict **still requires a
findings-log ledger** for the reviewed head (the single-agent path's
`write-gate-findings-log.mjs` writes it). Finding posting is likewise uniform: the inline
verdict takes `--findings-ledger <path>` for that same ledger, so the reduced review path
never reduces what gets threaded, and the close afterwards runs
`close-gate-findings.mjs --ledger <path> --allowed-refs <governing-issue>` for the disposition pass exactly as
[Finding threads and disposition](#finding-threads-and-disposition) requires for a fan-out
close. `requireFanoutProvenance`, when enabled, is
enforced **only for `fanout_fanin` verdicts** — a light inline verdict is already
scope-bounded and carries no multi-reviewer provenance, so it is exempt. Any inline
verdict that is over threshold, labelled `gate:full`, produced while `lightMode` is
disabled, or whose scope is underivable remains rejected exactly as before.

### Review-proportionality dispatch plan (non-overridable floors)

<!-- rule: GATE-EXEC-PROPORTIONALITY -->
`GATE-EXEC-PROPORTIONALITY`: The gate coordinator OWNS a deterministic, mandatory, auditable
dispatch plan computed from the diff for every gate round — execution mode/grouping
plus a provisional angle set — and it scales reviewer COST to the change's size and risk
WITHOUT lowering what is checked: trivial → single combined reviewer
(`inline_single_agent`, above); small/non-risky → a reduced angle set via a matched
[diff-class tier](#diff-class-angle-tiers), still dispatched `fanout_fanin`;
large/risky → full fan-out over the tier-or-best-effort angle set. The plan is a pure
composition of the existing decision functions — `resolveGateDispatchMode` (mode),
`resolveGateTier` (diff classification, and the angle set for a matched tier),
`selectFloorPlusJustifiedAngles` (the angle set for a no-tier diff), and
`resolveFanoutGroups` (dispatch-unit grouping) — exposed as ONE testable object
(`{ mode, angles, groups, reason, floors }`) via `resolveReviewProportionality`
(`@dev-loops/core/config`). It performs no I/O itself; `resolve-gate-dispatch.mjs`
(the gate coordinator's dispatch-decision step) is one of its two production callers and
supplies the diff-derived facts. Whenever a RISK-signal floor fires — a risk-path
touch, a non-clean/ambiguous size-budget outcome, missing changed-file evidence, or an
unclassifiable diff — the composer forces `full_fanout` DISPATCH but keeps a matched
tier's reduced set or, when no tier matched, selects the mandatory floor plus the
always-include angles present in the gate's pool and any consumer angle whose declared
`categories`/`kinds` intersects the diff. Kind-justified selection only bites where a
repo declares per-angle `categories`/`kinds`; this repo's own `.devloops` declares
none, so its composer no-tier set is the mandatory floor plus the always-include
angles (the resolver, which also sees the diff TEXT, may widen that set with
change-category-justified lenses). The hard size cap (`over_threshold`) likewise
forces `full_fanout` DISPATCH (one reviewer per emitted unit under
`GATE-EXEC-FANOUT-DISPATCH-EMIT`, never the light inline path) without widening the
angle set. See the floor-vs-tier precedence in the function's own doc comment.
`resolveGateAnglesDynamic` (the resolver `write-gate-context.mjs` calls to persist the
round's angle set) is the composer's second production caller and opts into the SAME
floor determination via its `checkFloors`/`sizeOutcome` parameters: the composer owns
floor determination and mode, while the persisted round's authoritative angle SET
comes from the resolver's tier-or-dynamic best-effort selection. The composer's no-tier
set is a lower bound of that authoritative set, except that a degenerate pool whose
best-effort selection is empty falls back to the whole static pool by design
(fail-closed — more angles, not fewer) and `gate:full` deliberately returns the full
static pool in the composer. There are never two parallel floor implementations. The
chosen mode/reason is recorded in gate evidence via the existing `--inline-reason`
marker (above) — the mechanism is unchanged, only the set of reasons a decision can
carry is extended (see below).

**Non-overridable floors.** Proportionality scales cost, never the floor: no flag,
waiver, prompt, or LLM judgment can lower any of these, and ambiguity resolves toward
MORE review (the light path is reachable only on PROVABLE triviality, never on
absence-of-evidence-of-risk):

- **Hard size cap** — `over_threshold` (unchanged, above): the diff exceeds
  `localImplementation.lightMode.maxFiles`/`maxLines`. This floor forces `full_fanout`
  DISPATCH (the emitted grouped/singleton units, never the light inline path) — it
  does NOT ADDITIONALLY force the full untriered angle pool: the diff-class-tier
  mechanism still applies, so an over-cap-but-tier-classifiable diff dispatches full
  fan-out over its matched tier's reduced angle set (the mandatory-angle floor, below,
  still always applies). The floors below are RISK signals; they also force
  `full_fanout` dispatch and refuse an explicit angle override, but they never widen
  the tier-or-best-effort angle set to the full untriered pool — the sole exception is
  the degenerate gate whose best-effort selection is empty, which falls back to the
  whole static pool by design (fail-closed: more angles, not fewer).
- **Risk-path denylist** — `risk_path_touch`: the diff touches a shipped,
  hard-coded, union-of-layers glob floor (`RISK_PATH_DENYLIST_DEFAULT`,
  `packages/core/src/config/config.mjs`) covering the gate/review, security/auth,
  contract, hook, and release trees, biased deliberately OVER-inclusive — see that
  constant's own doc comment for the exact glob list and per-category rationale
  rather than restating it here (single source of truth). A repo MAY only ADD extra
  globs on top via `localImplementation.lightMode.riskPaths`; it can never remove a
  shipped entry. Changed-file evidence that is itself unreadable/absent
  (`changed_files_unavailable`) fails the same way — full fan-out, never inline.
- **Size-budget outcome** — `size_outcome_escalate` / `size_outcome_block` /
  `size_outcome_t1`: the diff's `check-size-budget.mjs` outcome (reused as-is, no new
  computation) is not a clean `pass`, or its T1-tier slice is nonzero. Unreadable
  size-budget evidence (`size_outcome_unavailable`) fails the same way.
- **Unclassifiable diff** — `unclassifiable_diff`: `resolveGateDispatchMode` alone has
  no diff-classification awareness (only `resolveGateTier` does), so the composer
  additionally forces `full_fanout` whenever `resolveGateTier` reports
  `unclassifiable_file` (a changed file `classifyFile` cannot categorize) — an
  unclassifiable diff is ambiguity too, and must never silently reach inline just
  because the raw dispatch-mode facts alone looked trivial. Its angle set remains
  the mandatory floor plus any best-effort justified lenses — the whole static pool
  only for a degenerate pool whose best-effort selection is empty (the intended
  fail-closed fallback).
- **Mandatory-angle floor** — unchanged (above): mandatory angles are always unioned
  into the resolved angle set (`resolveGateAngles`/`resolveGateTier`), whether the
  round is fan-out or inline; on the inline path they are COMBINED under the one
  reviewer, never dropped.
- **No silent loosening** — the cap and the risk-path ADDITION field
  (`localImplementation.lightMode.maxFiles`/`maxLines`/`riskPaths`) live in
  `.devloops`; a base-vs-head change to any of them (add, modify, or remove) trips
  the ADR tripwire (`check-adr-tripwire.mjs`'s `devloops-proportionality` trigger) —
  see [ADR-WORTHY-PERSIST](./decision-record-contract.md). The shipped
  `RISK_PATH_DENYLIST_DEFAULT` floor itself is a hard-coded JS constant precisely so
  no config layer — shipped or repo-local — can ever silently drop it; a change to
  it is an ordinary source-code review, not a config toggle.

**Merge-gate re-verify.** A recorded light-mode decision whose diff was not eligible
fails closed at merge time, the same way `requireFanoutProvenance` re-verifies
fan-out evidence rather than trusting it: `detect-checkpoint-evidence.mjs`'s
`scopeUnderThreshold` re-derivation (above) now ALSO recomputes both new floors from
the actual merge-base diff — `touchesRiskPath` over the merge-base changed-file list,
and `evaluatePrSizeBudget` over the merge-base diff — and accepts the inline verdict
only when the size cap AND the risk-path floor AND the size-outcome floor ALL pass.
The recorded `inlineReason` marker is **audit-only** here: it is never trusted for
accept/reject, only recomputed evidence is. A verdict claiming `under_threshold` whose
actual merge-base diff touches a risk path, or whose size-budget outcome is not a
clean non-T1 `pass`, is rejected exactly as an over-cap diff already is.

### Diff-class angle tiers

<!-- rule: GATE-EXEC-DIFF-CLASS-TIER -->
`GATE-EXEC-DIFF-CLASS-TIER`: A gate MAY configure `gates.<gate>.tiers`, an ordered,
first-match-wins list of diff classes (`match: { kinds?, maxFiles?, maxLines? }`), each
naming a reduced angle set for the diffs it matches. A tier round is FANOUT-ONLY: it is a
normal `fanout_fanin` round with a smaller resolved angle set, produced by a real
per-angle fan-out, a real findings-log ledger, and real provenance; there is no separate
evidence path and no new `executionMode`. The resolver unions the gate's mandatory angles
into every matched tier's set, so `GATE-EXEC-ANGLE-COVERAGE` holds unchanged. A tier
miss or uncertain input — no configured tiers, an unclassifiable file, a dev-loop
config-source path, unavailable diff/scope, or an angle outside the gate's resolved
pool — falls through to dynamic best-effort selection rather than expanding to the
untriered pool. The `gate:full` label bypasses tier matching but does not weaken the
mandatory floor.

**Precedence.** `gate:full` label > lightMode inline (dispatch-level) > tier > dynamic
subtractive reduction > mandatory-floor best-effort selection. The tier is consulted first, and Phase 2's
carry-forward subtraction runs second, against whichever tiered or mandatory-floor
best-effort set the tier decision left in place. Subtractive reduction alone was insufficient for the diff classes a
tier targets: `dynamic.subtractive` reduces per CATEGORY, so it still keeps the full
per-category width for a triggered category (a docs change still runs every doc-inclusive
angle); a tier instead caps the whole set for a diff class known in advance to be small or
non-code, which subtractive reduction by category cannot express.

The handoff envelope built for the fan-out advertises the gate's UNTRIERED run-set; tier
reduction is applied when the per-round context artifact is built, not reflected back into
the envelope's own advertised angle set. The gate coordinator's dispatch-decision output
(`resolve-gate-dispatch.mjs`) instead carries the composer's tiered or file-kind best-effort
set — a lower bound. The per-round context resolver (`resolveGateAnglesDynamic`) may widen
that lower bound with lenses justified by hunk-derived change categories; its persisted set
is authoritative for review.

### Fan-out provenance (closing the self-produced-artifact loophole)

`requireFanoutEvidence` is artifact-based: it only proves a `fanout_fanin` verdict
carries a findings-log ledger. A single agent could self-produce every per-angle
artifact + the ledger and label the verdict `fanout_fanin`, satisfying the letter
of the gate while defeating independent parallel review. To close this, the
findings-log ledger can additionally record **fan-out provenance**:

```jsonc
"provenance": {
  "distinctReviewers": 2,               // count of distinct reviewer agents dispatched (<= distinct identities in perAngle)
  "perAngle": [                          // per-angle dispatch provenance
    { "angle": "scope",   "reviewer": "review-a", "dispatchId": "…", "model": "…", "group": "docs-surface" },
    { "angle": "docs",    "reviewer": "review-a", "dispatchId": "…", "model": "…", "group": "docs-surface" }, // "group" is REQUIRED whenever fresh angles share one reviewer identity (grouped dispatch, the shipped default) — see the grouped-dispatch exception below
    { "angle": "safety",  "reviewer": "review-b" }
  ]
}
```

Provenance is written via `write-gate-findings-log.mjs --provenance <json>` (validated
on write; malformed OR self-inconsistent provenance fails the write). It is **optional
and additive** — when omitted, the ledger is byte-identical to before and no enforcement
changes. **Internal-consistency rule** (enforced on both the write path and the
enforcement read path): `perAngle` must be non-empty when `distinctReviewers > 0`, and
`distinctReviewers` must be `<=` the count of DISTINCT reviewer identities actually
recorded in `perAngle` (distinct by `reviewer`, else `dispatchId`; a bare `{angle}` is
not a countable reviewer). You cannot claim more reviewers than you recorded dispatch
entries for — this closes the `{distinctReviewers: 2, perAngle: []}` loophole.

**One scoped reviewer per fresh dispatch unit (always-on write-time floor).** `fanout_fanin`
execution mandates one independent reviewer per emitted dispatch unit (including grouped
`gate:full` dispatch under `GATE-EXEC-FANOUT-DISPATCH-EMIT`) because
recording an internally-consistent `distinctReviewers` count is not enough on its own:
one reviewer could still cover two angles without that count ever going inconsistent. The
write path additionally rejects, unconditionally (not gated by `requireFanoutProvenance`),
any `perAngle` where two **fresh** angles (angles WITHOUT `carriedFromHead`) share one
reviewer identity, **and** any fresh angle recording no reviewer identity at all (a bare
`{angle}` entry is permitted only as a carried entry; a fresh entry must carry `reviewer`
or `dispatchId`) — the error names the colliding or anonymous angle(s). The check enforces
the per-identity relation itself, so a padded ledger (duplicate-angle entries inflating
the distinct-reviewer count) cannot slip one reviewer covering two fresh angles. A `carriedFromHead`
angle is exempt from this pairing check entirely (see
[Angle carry-forward](#angle-carry-forward-fail-closed)) — recording the prior head's
reviewer identity on the carried entry is preferred (honest attribution) but optional,
and reusing that identity on a carried angle is never a collision. The sanctioned
non-fan-out path for a single-reviewer run is `executionMode: inline_single_agent` with
a recorded `--inline-reason`, not a `fanout_fanin` ledger that pairs one reviewer across
angles. **Grouped fan-out dispatch** (`gates.fanout.mode: grouped`, the shipped default —
see `resolveFanoutGroups` in `@dev-loops/core/config`) is a second sanctioned exception: a
`perAngle` entry may declare a `group` name, and fresh angles sharing one reviewer identity
are valid exactly when every entry sharing that identity declares the SAME `group` name
**AND** — whenever the caller supplies the round's resolved dispatch groups (both call
sites do, `write-gate-findings-log.mjs` via its own `--full-label` flag threaded into
`resolveFanoutGroups` just like `write-gate-context.mjs`'s) — every one of those fresh
angles is a member of that SAME dispatch unit: the recorded `provenance.dispatchUnits` unit
(itself a union of whole cap-split `resolveFanoutGroups` base units of at most 5 angles) or,
for a ledger without recorded membership, the same base unit (`GATE-EXEC-FANOUT-CAPACITY`). A
self-attested `group` label spanning angles the
configured table splits apart (or never groups together at all) fails closed even though
the label itself is internally consistent; `resolveFanoutGroups` emits one-angle-per-unit
singletons for `gates.fanout.mode: per-angle` (bypasses configured groups), so passing its
output here rejects ANY shared identity in that mode, with no separate mode flag needed.
As of #1601 (ADR 0048) `gate:full` dispatches GROUPED, so a shared identity within an
auto-chunked dispatch unit is honored exactly as for a configured group. Fresh angles sharing a reviewer under differing or missing
`group` values still violate the contract above. The shared helper is
`fanoutReviewerPairingError` (paired with `countFreshDispatchUnits`) in
`@dev-loops/core/loop/gate-fanin`.

Enforcement of the `distinctReviewers` floor itself is opt-in via
**`gates.requireFanoutProvenance`** (default **false**). When enabled, it layers ON TOP of
`requireFanoutEvidence` (it only takes effect while fan-out evidence enforcement is
active): each required `fanout_fanin` gate's ledger must record internally-consistent
provenance with `provenance.distinctReviewers >= max(2, <fresh DISPATCH UNIT count>)` — a
floor of **2** is the smallest count that is not a single agent, and the floor SCALES UP
with the number of fresh (non-carried) DISPATCH UNITS recorded in `perAngle`
(`countFreshDispatchUnits`: one unit per distinct declared `group` name among fresh
entries, plus one unit per fresh entry with no `group` at all) — NOT with the fresh-angle
count. For an ungrouped ledger the two counts are identical (today's one-reviewer-per-angle
shape); for a grouped ledger the unit count is <= the angle count, since one group of N
angles is one dispatch unit, not N — a compliant ledger can never have fewer distinct fresh
reviewers than fresh dispatch units. The read path also re-validates the per-identity
pairing itself (the same `fanoutReviewerPairingError` check as the write path, at both the
pre-merge enforcement and the cross-checkout ledger selector): the ledger is a
worktree-local file, so the reader never assumes the write-time floor produced it — a
hand-crafted padded ledger that meets the cardinality floor still fails. When the flag is
off, behavior is byte-identical to today (no new failures) — the Claude-Code path, which
already honors child fan-out, is a validated no-op.

**Honest caveat (this is NOT un-forgeable):** recorded provenance is self-reported — it is
written by the same agent whose independence it claims — so a determined single agent can
still forge an internally-consistent blob. This enforcement raises the bar (rejects
malformed/inconsistent provenance and requires distinct recorded dispatch entries) but
does NOT claim un-forgeable enforcement. Un-forgeable recording (the harness attesting who
actually ran each per-angle review) is the Pi-harness bridge — the subagent tool honored
at child depth (see #1084).

This provenance layer is distinct from the underlying gate verdict itself. The clean
draft transition record and current-head `pre_approval_gate` verdict are enforced
server-side by the `gate-evidence` check
(`.github/workflows/gate-evidence.yml`, [Merge preconditions](./merge-preconditions.md#items-3-and-4-apply-to-every-path-not-just-the-dev-loop-tooling)),
which re-runs `detect-checkpoint-evidence.mjs --skip-fanout-ledger-check` on GitHub's own
token so that — once branch protection on `main` requires it — an API-driven ready/merge
transition cannot skip it. (Until that operator step lands the check runs and reports but
does not yet block merge.) That flag deliberately
does NOT re-verify the findings-log ledger/provenance/angle-coverage layer described
above: the ledger is a gitignored, machine-local `tmp/` file (under the main worktree, #2315) that only the machine
that ran the review has on disk, so a stateless CI runner can never see it. That
narrower gap is exactly what this caveat and the Pi-harness bridge remain scoped to.

### Angle-coverage enforcement (mandatory angles + pool membership)

<!-- rule: GATE-EXEC-ANGLE-COVERAGE -->
`GATE-EXEC-ANGLE-COVERAGE`: A `fanout_fanin` verdict's recorded per-angle results
(`provenance.perAngle` on the write path / merge-evidence read path, and the
`--findings-json` structured per-angle results on the verdict-comment path) MUST
cover every angle in the gate's effective mandatory angles (entries with
`mandatory: true`), and MUST NOT name an
angle outside the gate's effective pool unless `gates.rejectForeignAngles` is
explicitly set to `false`, in which case a foreign angle downgrades to a warning.
The effective contract is `resolveGateAngleContract` (`@dev-loops/core/config`),
the single resolver every consumer uses: the mandatory-angle set is filtered
through entries disabled via `enabled: false` (an excluded mandatory angle must
not deadlock every fanout write), and the pool is `resolveGateAngles` (configured
angles minus disabled entries), widened to the global lens catalog
(`resolveAnglePool`) when the gate enables `gates.<gate>.dynamic.additive` —
dynamic resolution may legitimately dispatch catalog angles then, with a
disabled entry still a hard ceiling. A delta-suffixed angle (`<angle>-delta-at-...`, e.g. a re-review scoped
to only the current head's delta) counts toward its base angle for both checks.
Fan-in synthetic angles (`FANIN_SYNTHETIC_ANGLES` from `@dev-loops/core/loop/gate-fanin`;
currently `pr-checklist`, the entry `consolidate-fanin --pr-checklist clean`
upserts) are always legal in the foreign-angle check, regardless of pool config,
`gates.rejectForeignAngles`, or an `enabled: false` entry for the angle. The entry is
minted by the fan-in itself, never dispatched from the pool, so a gate whose pool omits
the angle (e.g. the shipped draft pool) accepts it without listing it per-gate; the
disabled-entry ceiling above still governs pool WIDENING (dynamic dispatch), while this
exemption covers only the fan-in-minted recorded entry. The angle may additionally be
pool-configured where a gate wants it reviewed as a real angle — the shipped preApproval
pool lists `pr-checklist` as mandatory. Since #1877 the angle's completeness duty is
machine-backed: the deterministic pre-approval block (`upsert-checkpoint-verdict.mjs`, see
[Acceptance Criteria Verification](acceptance-criteria-verification.md) step 7) fails the gate
closed on any unchecked `- [ ]` in the PR body's AC/DoD checklist, so the angle's reviewer
keeps only the TRUTHFULNESS half (verify each ticked `[x]` is real) plus matrix-mirror
conformance — completeness itself is no longer a soft reviewer judgment. The boundary is
explicit: the deterministic check enforces completeness (nothing left unchecked/forgotten),
NOT truthfulness; both layers stay.
This is independent of `requireFanoutProvenance`, and is exempt for
`inline_single_agent` verdicts (light-mode inline runs carry no per-angle fan-out
data to validate). At merge-evidence time, when a gate configures any mandatory
angle, a `fanout_fanin` ledger MUST record internally-consistent provenance —
absent or invalid provenance fails closed, so a hand-edited or shadow ledger
cannot bypass mandatory-angle coverage by simply omitting provenance; gates with
no mandatory angles keep the previous behavior (absent provenance adds no
failure unless `requireFanoutProvenance` is on). Enforced identically by
`write-gate-findings-log.mjs` and `upsert-checkpoint-verdict.mjs` (write time)
and `detect-checkpoint-evidence.mjs` (merge-evidence time), sharing the same
pure coverage check (`checkFanoutAngleCoverage` in
`@dev-loops/core/loop/gate-fanin`).

### Fail-closed: fan-out unavailable → route to conductor {#fail-closed-fan-out-unavailable--route-to-conductor}

When a child/agent **cannot** perform real parallel fan-out (e.g. a harness that does not
honor the subagent tool at child depth), the flow MUST fail closed rather than silently
degrade to a single-agent inline review. The canonical, matchable signal is the exported
constant `FANOUT_UNAVAILABLE_MESSAGE` (`@dev-loops/core/loop/gate-fanin`):

> **fan-out unavailable — route to conductor**

`fanoutUnavailableError(detail)` builds an `Error` carrying this prefix plus
`{ routeToConductor: true, code: "FANOUT_UNAVAILABLE" }`. Callers throw it (or check
`err.routeToConductor === true`) to hand the gate review up to the conductor. The
`requireFanoutProvenance` pre-merge failure message references this same contract string.
The full end-to-end driving command that dispatches per-angle review subagents at child
depth is provided by the Pi-harness child (the bridge); this contract specifies only the
recording + enforcement + fail-closed signal that land independently.

Under `GATE-EXEC-GATE-COORDINATOR`, the gate coordinator returns this signal to the dev-loop
coordinator as the round's result. The dev-loop coordinator then stops for an operator's
per-PR decision and never runs the round inline.

## Additive review-lineage composition (Section E)

The offline `packages/core/src/loop/review-lineage.mjs` builder composes a stable
`review-lineage-base` with deterministic per-fix-round `round-N-delta` artifacts;
round 2+ appends only changes to that composition. It has no GitHub, harness or
clock dependencies (`packages/core/test/review-lineage.test.mjs`). This artifact
composition does not replace the runtime gate chain: Phase 1 rebuilds current-head
context on every head bump, and the carry-forward rebuild passes `--prev-head`
to seed bounded advisory disposition memory for reviewers that re-run (ADR 0070).

### Artifact model

```text
review-lineage-base          lineageId + gate + stable contracts/instructions
                             + ORIGINAL review target + ORIGINAL full diff

round-N-delta                exact baseHead/reviewedHead SHAs + the fix diff
                             + validation evidence + an INDEPENDENT findings
                             verification checklist (not verdict prose)
```

`buildReviewLineageBase` and `buildFixRoundDelta` are byte-deterministic: the
same inputs produce a byte-identical artifact (`baseHash` / `deltaHash`), so a
consumer can prove two runs share a base/delta without re-comparing bodies.

### Append-only composition (`composeRoundRequest`)

```text
round-N request = [lineage base][delta 1][delta 2]...[delta N][angle suffix]
```

Composition is **append-only**: the composed request is the ordered
concatenation of the lineage base and individual delta artifacts, never a
parse/reserialize of the full PR context as a replacement block. Round N+1
appends exactly one new delta segment; every prior segment is byte-identical
(same `slot` + `ref` + `hash`). Consumers render by concatenating segment bytes
in order (`renderComposedRequest`, or segment-by-segment). Contiguity is
fail-closed (`newDelta.round` must follow the prior deltas exactly) and
delta/base `lineageId` must match.

### Carry-forward semantics (unchanged)

The lineage composer only PRESERVES carry-forward provenance (`carriedAngles`
= `{ angle, originalReviewer, priorHead }`); it never decides carry-forward
(that stays in `gate-carry-forward.mjs`) and never fabricates a verdict. A
carried clean angle still records its ORIGINAL reviewer and PRIOR head,
unchanged from the existing carry-forward contract. The composed request weaves
that provenance into its `composedHash`.

### Compaction / rebase policy (slice 6)

Unbounded delta accumulation would eventually overflow provider prompt-cache
breakpoint/lookback limits and the context window. A documented compaction
(rebase) rule bounds the composed lineage so it cannot grow without limit.

**Threshold.** A rebase is triggered when EITHER bound is exceeded:

- the accumulated round-delta count exceeds `maxRounds` (default
  `DEFAULT_LINEAGE_MAX_ROUNDS`, `20`), OR
- the composed lineage byte size exceeds `maxLineageBytes` (a provider context
  budget a consumer may set) when one is configured.

`checkLineageCompaction({ lineageBase, deltas, maxRounds, maxLineageBytes })`
returns `{ requiresCompaction, reason, ... }` (pure predicate — never mutates).

**Rebase behaviour.** `rebaseLineage({ lineageBase, deltas, currentDiff? })` folds
the accumulated deltas into a new compacted `review-lineage-base`: `originalHead`
advances to the latest reviewed head and `originalDiff` becomes the cumulative
/ concatenated diff text (the original full diff joined with every accepted fix
diff, in order — an accumulated text fold, not a patched merge). A caller may
explicitly supply `currentDiff` to override that folded text outright. The
compacted base keeps the same `lineageId`/`gate`, is itself a valid base that
`composeRoundRequest` accepts unchanged, and records `rebaseSourceBaseHash` +
`compactedRoundCount` (and sets the reserved `compaction: true` marker field)
for traceability. Subsequent rounds append fresh deltas
to the compacted base, so the composed request stays within the provider
breakpoint/lookback + context budget. Composition rules are preserved: a new
round-1 delta whose `baseHead` equals the compacted base's `originalHead`
composes cleanly, byte-deterministically, with SHA-chain continuity. Prior
delta artifacts remain available (append-only history); only the composed
request is recomposed from the compacted base.

Covered by the compaction suite in `packages/core/test/review-lineage.test.mjs`
and the end-to-end fixture `packages/core/test/review-lineage-e2e-fixture.test.mjs`
(driving request plan → fan-out/fan-in → lineage delta → compaction
for two rounds).

### Non-goals preserved

- No provider cache-reuse claim from artifact hashes (telemetry capability
  rules live in `review-dispatch-plan.mjs`).
- No continuity-reviewer convergence loop or calibration audit yet — those are
  later #1468 slices (6/7) and are NOT introduced here.
- Round-1 fresh one-reviewer-per-angle provenance and fan-in semantics are
  untouched.

## See also

- [Checkpoint Verdict Comment Contract](gate-review-comment-contract.md) — visible PR comment evidence format
- [PR Lifecycle Contract](./pr-lifecycle-contract.md) — broader lifecycle state machine
- [Copilot PR Follow-up](../copilot-pr-followup/SKILL.md) — skill that owns gate execution
- [Local Implementation](../local-implementation/SKILL.md) — uses chain pattern for local phase plan audits
- [Contract style guide](./contract-style-guide.md) — rule ID and RFC-2119 conventions
