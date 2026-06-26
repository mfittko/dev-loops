# Plan — Issue #895: make the gate fan-out actually fork from the context-builder

Status: refinement plan (READ-ONLY analysis; not implemented)
Source issue: mfittko/dev-loops#895 (bug) — owner decision recorded in the issue comment "Converged design (operator-approved)": resolve by building a NEUTRAL context bundle ONCE (deterministic script) and seeding each independent reviewer with it — **no fork primitive, no Workflow dependency**. (An earlier "Option 1: fork via the Workflow tool" framing was explored and then superseded — see §0 for the governing design and §§1–12 for that investigation history.)
Related: epic #867 (closed), #885 (closed, full-diff + adjacent code), #886, #875 (Phase 1 evidence/disclosure).

---

## 0. CONVERGED DESIGN (operator-approved — supersedes the fork/Workflow approach below)

> The fork/Workflow framing in §§1–12 is **superseded**. After working RFC-1/RFC-2 with the operator (see issue #895 comment "Converged design"), the resolution is: **no fork primitive, no Workflow dependency.**
>
> **Architecture:**
> 1. **Deterministic context-builder (script, not agent).** Enhance `write-gate-context.mjs` to emit a *generous, neutral* context bundle once: full diff + structurally-adjacent code (callers/callees/imports of changed symbols), with size guards (skip lockfiles/generated/binary/minified, cap per-file bytes, truncate long tail). A script guarantees neutrality + determinism.
> 2. **Reviewers seeded with the verbatim artifact** via the plain **Agent tool** (auto-invoked, no operator opt-in — automation-safe). Each reviewer prompt = identical neutral bundle + its angle; reviewers widen per-angle on top only when needed.
> 3. **Fan-in unchanged** (`consolidateFanin` → ledger + verdict).
>
> **Primary win = work-dedup** (build once vs N× re-derivation) — *guaranteed*, independent of caching. Prompt-cache of the shared prefix is a *bonus*. **This dissolves RFC-1 as a go/no-go blocker.**
>
> **RFC-1: RESOLVED** — abandon literal fork; build-once + verbatim-seed; cache opportunistic.
> **RFC-2: RESOLVED** — "fresh" = reviewer context is *the neutral builder artifact + its angle, NOT the main agent's state*; `verify-fresh-review-context.mjs` treats the injected neutral bundle as the intended seed (not contamination) while still forbidding main-agent / cross-session bleed.
>
> **Revised phases:** (A) enhance `write-gate-context.mjs` (generous adjacent code + size guards) + tests; (B) reviewer-seeding pattern — `review.agent.md` consumes the provided bundle as its base (widen only if needed) + the gate procedure/skill passes the artifact verbatim to each reviewer; (C) reconcile `verify-fresh-review-context.mjs` to the RFC-2 semantics; (D) rewrite `docs/gate-review-sub-loop-contract.md` + CHANGELOG to the build-once-neutral-bundle model, drop all "fork" language; (E) tests: work-dedup/parity + RFC-2 guard + contract no-fork-claim. Evidence wiring (`fanout_fanin` mode, head-SHA ledger, verdict) is unchanged.
>
> Sections §§1–12 below are retained as the investigation record; read them for surface-mapping, but the **approach, RFC resolutions, and phases above govern**.

---

## 1. Problem statement

Epic #867 + #885 designed the gate fan-out so a dedicated **context-builder** loads the full PR diff + adjacent code once, and each per-angle `review` agent **forks from it**, inheriting that loaded context at high input-token cache-hit rates (#885's stated cost rationale: "if the context agent is forked, any forking subagents will have high input token cache hit rates"). Forking is the headline cost property of the entire sub-loop and the stated justification for running many angles.

As executed under the Claude Code harness, the per-angle reviewers are spawned as **independent `Agent` subagents**, each starting with fresh context and independently re-deriving the diff/adjacent code. `write-gate-context.mjs` produces the handoff artifact, but reviewers consume it by *re-reading* (path-based), not by *forking* (context-inheritance). Net effect:

- N reviewers each pay the full input-token cost to re-read the diff — exactly the N× cost the fork design was meant to collapse.
- No shared-context cache benefit (#885's rationale is unrealized).
- The `fanout_fanin` verdict/evidence is genuine (real independent angle reviews + `consolidateFanin`), but the *forking* (the efficiency mechanism) is absent, and the contract/docs overstate how the gate runs.

This paused the v0.3.0 release: the gate's headline mechanism is not honest.

### Critical pre-existing tension (must be resolved before implementation — see §10 RFC escalation)

The current contract and `review` agent **mandate fresh context and fail closed on inherited context**, which is the exact opposite of fork-inherit:

- `agents/review.agent.md`: `defaultContext: fresh`; scoped angle-review mode requires `verify-fresh-review-context.mjs --scope <angle>` at startup and "refuse to proceed on contamination — do not review on inherited context."
- `docs/gate-review-sub-loop-contract.md` Phase 1/Phase 2: "fresh context (do not fork the parent session just to share chat history)"; "starts in fresh context (do not inherit prior conversation state)."
- `scripts/github/verify-fresh-review-context.mjs` returns `fresh: false` (exit 1) on any inherited sentinel and instructs `Restart the subagent with fresh context (subagent({context:"fresh"}))`.

A forked reviewer **inherits the context-builder's loaded context by design** — that is the cache-hit mechanism #885 wants. Under the current guard, a forked reviewer would be detected as contaminated and refuse to run. So #895 cannot be a pure orchestration swap: it requires deciding what "fresh" must mean for a forked reviewer (fresh *conversation/turn state* vs. inherited *read-only diff/adjacent-code context*), and reworking the fresh-context guard + contract language accordingly. This is the load-bearing design decision and is escalated in §10.

---

## 2. Investigation findings (current implementation surface)

| Surface | File | Role today | Change needed for #895 |
|---|---|---|---|
| Context artifact | `scripts/github/write-gate-context.mjs` (`buildGateContext`, `buildGateContextPath`, `buildGateDiffPath`, `readGateContext`) | Resolves dynamic angles via `resolveGateAnglesDynamic`; writes `tmp/gate-context/.../<gate>-<headSha>.json` + `.diff`; records `scope.diffPath`/`scope.changedFiles` | Becomes the work the **context-builder stage** performs (or wraps). Artifact stays the audit anchor. No schema change strictly required. |
| Fan-in consolidation | `packages/core/src/loop/gate-fanin.mjs` (`consolidateFanin`, `toFindingsLogShape`, `planFanoutBatches`, `DEFAULT_MAX_FANOUT_REVIEWERS`) | PURE; consolidates per-angle artifacts → verdict + findings; plans cap/batches | Unchanged (reused as-is). The fan-in step consumes the same per-angle artifacts whether reviewers forked or not. |
| Ledger | `scripts/github/write-gate-findings-log.mjs` (`buildLogPath`) | Writes durable disposition ledger `tmp/gate-findings/.../<gate>-<headSha>.json` | Unchanged. Still written before the visible comment. |
| Verdict | `scripts/github/upsert-checkpoint-verdict.mjs` (`--execution-mode fanout_fanin|inline_single_agent`, `--inline-reason`) | Records executionMode in the visible gate comment marker | Unchanged. Still emits `fanout_fanin`. |
| Pre-merge enforcement | `scripts/github/detect-checkpoint-evidence.mjs` (`buildPreMergeGateCheck`, `buildFanoutEnforcement`) | Fails closed (`gates.requireFanoutEvidence`, ON by default) unless required gate ran `fanout_fanin` AND a head-SHA ledger exists | Unchanged. The fork rework must keep producing exactly these two evidences. |
| Scoped reviewer | `agents/review.agent.md` (scoped angle-review mode) | Fresh-context, single-angle, read-only; reads `scope.diffPath`/`changedFiles`; writes `tmp/gate-reviews/.../<angle>.json` | Reworked: forked variant inherits context-builder's loaded diff/adjacent code; fresh-context guard semantics revised (see §10). |
| Procedure | `skills/copilot-pr-followup/SKILL.md` §"Gate fan-out/fan-in procedure (agent-orchestrated)" (lines ~301–309) | Conductor agent spawns reviewers as independent `Agent` subagents | Reworked to drive the gate sub-loop through the Workflow tool (`context-builder stage → parallel([forked reviewers]) → fan-in`) under the supporting harness; documented fallback otherwise. |
| Contract | `docs/gate-review-sub-loop-contract.md` | Describes "Fork fan-out" but wires independent reviewers; mixes "fork" + "fresh context, do not fork" | Rewritten to describe the real execution model per harness, with no overstated fork claim. |
| Config | `packages/core/src/config/config.mjs` (`resolveMaxFanoutReviewers` default 8, `resolveRequireFanoutEvidence` default on, `resolveGateAnglesDynamic`) | Caps/flags | Likely unchanged; possibly add a harness/execution-strategy flag (see §6 / open questions). |
| Tests | `test/github/write-gate-context.test.mjs`, `test/github/detect-checkpoint-evidence.test.mjs`, `test/github/upsert-checkpoint-verdict.test.mjs`, `packages/core/test/gate-fanin.test.mjs` | Cover artifact/evidence/verdict/consolidation | Add a fork-cache-evidence check + execution-model parity tests (see §8). |

### The fork mechanism (as understood)

- The `Agent` tool starts a **fresh** subagent on every call — there is no fork-from-a-prior-agent's-context. This is why today's spawn-per-angle never forks.
- The fork/inherit primitive lives in the **Workflow** tool: a `subagent_type: "fork"` (or equivalent) stage whose forks inherit the parent stage's context/model, plus `parallel()`/`pipeline()` fan-out. The Workflow tool runs as a background orchestration that spawns agents.
- Target mapping: a gate invocation becomes a Workflow (script or reusable named workflow) that runs a **context-builder stage** (loads diff + adjacent code once, writes the existing artifact) → `parallel([forked reviewers])` (one fork per resolved angle, bounded by `gates.maxFanoutReviewers`, overflow batched by `planFanoutBatches`, each fork inheriting the context-builder's loaded context and scoped to one angle, writing its per-angle findings artifact) → **fan-in stage** (`consolidateFanin` + `toFindingsLogShape` → ledger → visible comment → `fanout_fanin` verdict).

This plan does NOT assume the Workflow tool's fork actually delivers context-inheritance cache hits in this environment. Validating that assumption is Phase A's gate; if it fails, see §10 (hard-blocker RFC).

### Harness reality

- The dev-loop runs under both Pi and the Claude Code harness (single-agent). The Workflow tool's fork/parallel primitive is the cost-efficiency mechanism but is not guaranteed to exist/behave identically in every harness.
- This repo defines no Workflow-tool fork primitive of its own; it is a harness-provided orchestration tool. So #895 is fundamentally a question of **which harness can fork-inherit**, with a documented, non-overstated fallback for harnesses that cannot.

---

## 3. Target execution model (concrete)

Reusable named workflow `gate-fanout` (one invocation per gate per head SHA), with the same shape for `draft_gate` and `pre_approval_gate` (parity required):

```
workflow gate-fanout(repo, pr, gate, headSha, config):
  stage context-builder (single agent, loads context ONCE):
    - resolve angles: resolveGateAnglesDynamic(config, configKey, { diff })
    - load FULL diff + adjacent/related code (callers, callees, validators,
      contracts, sibling impls) into this stage's context
    - write artifact + .diff via buildGateContext  → scope.diffPath / scope.changedFiles
    - emit: { artifactPath, diffPath, resolvedAngles, batches } where
      batches = planFanoutBatches(resolvedAngles, resolveMaxFanoutReviewers(config))

  stage fanout = for each batch (sequential across batches, parallel within):
    parallel([ fork(reviewer, angle) for angle in batch ]):
      - subagent_type: fork  → INHERITS context-builder's loaded diff/adjacent code
      - scoped to exactly ONE angle (review.agent.md scoped mode)
      - read-only; MAY widen scope (records contextWidened)
      - writes tmp/gate-reviews/<repo-slug>/pr-<N>/<gate>-<headSha>/<angle>.json
    - record degraded=true in evidence when batches.length > 1
    - emit fork-cache evidence (cache-hit / shared-context marker) per reviewer

  stage fan-in (single agent):
    - read all per-angle artifacts
    - consolidateFanin({ angleResults, blockCleanOnFindingSeverities })
    - toFindingsLogShape(...) → write-gate-findings-log.mjs  (ledger, BEFORE comment)
    - post-gate-findings.mjs   (visible findings comment, gated by postFindingsComments)
    - upsert-checkpoint-verdict.mjs --execution-mode fanout_fanin  (verdict comment)

  retry (Phase 5): on blocking findings, fix on branch, advance head SHA,
    re-run workflow; only re-fork findings_present angles; context-builder + fan-in
    always re-run.
```

Per harness:
- **Forking harness (Pi / Workflow-tool fork available):** run the workflow above; forked reviewers inherit context; record fork-cache evidence.
- **Non-forking harness (current Claude Code single-agent path, if fork unavailable):** documented fallback — reviewers are independent fresh-context subagents reading the artifact (today's behavior). The verdict still says `fanout_fanin` (the fan-out genuinely ran), but the contract must explicitly state that under this harness reviewers are independent and rely on the artifact + prompt caching for whatever reuse is achievable — **no overstated fork claim**. Optionally record an execution-strategy field (`forked` vs `independent`) in the gate evidence so the audit trail is honest about how reviewers obtained context (see open questions Q3).

---

## 4. Acceptance criteria

Exact wording from issue #895's "Acceptance" section is preserved (AC1–AC4); AC5–AC8 are derived from the owner decision comment and the deliverable spec and are marked as derived.

- AC1: Decide and implement the execution model (fork via Workflow, or documented-independent). [source-exact]
- AC2: If forking: demonstrate reviewers inherit the context-builder's loaded diff/adjacent-code (cache-hit or shared-context evidence). [source-exact]
- AC3: `docs/gate-review-sub-loop-contract.md` accurately describes how reviewers actually obtain context, with no overstated fork claim. [source-exact]
- AC4: v0.3.0 release notes/CHANGELOG reflect the true execution model. [source-exact]
- AC5 (derived): The gate sub-loop is driven through the Workflow tool as `context-builder stage → parallel([forked reviewers]) → fan-in` for both `draft_gate` and `pre_approval_gate` (parity), on the harness that supports forking.
- AC6 (derived): Evidence/contract parity is preserved — every reworked gate pass still produces `executionMode: fanout_fanin`, a findings-log ledger for the head SHA, the gate-context artifact, and the verdict comment, exactly as `detect-checkpoint-evidence.mjs` / `buildFanoutEnforcement` require. `consolidateFanin`, the ledger schema, and the verdict schema are unchanged.
- AC7 (derived): Harness compatibility is explicit. On a harness where forking is unavailable, the documented fallback runs and the contract/docs do not imply a fork that is not happening.
- AC8 (derived): The fresh-context contract tension (§1) is resolved by an explicit, recorded decision (RFC outcome, §10): what "fresh" means for a forked reviewer, and how `verify-fresh-review-context.mjs` + `agents/review.agent.md` + the contract are reconciled with fork-inherit.

---

## 5. Definition of done

No explicit DoD exists in issue #895, so a Proposed DoD is provided.

### Proposed DoD

1. Execution model decided and recorded (RFC outcome in §10 closed) before code changes; the fresh-vs-fork tension (§1/AC8) is resolved with a written decision.
2. `gate-fanout` Workflow (script or reusable named workflow) implemented, parameterized by `(repo, pr, gate, headSha, config)`, with stages context-builder → `parallel([forked reviewers])` → fan-in.
3. Context-builder stage loads full diff + adjacent code once and writes the existing `tmp/gate-context/.../<gate>-<headSha>.json` + `.diff` artifact via `buildGateContext` (or a thin wrapper); `scope.diffPath`/`scope.changedFiles` preserved.
4. Forked reviewers inherit the context-builder's loaded context (on the forking harness), are scoped to one angle, read-only, may widen scope, and write the per-angle artifact at the existing deterministic path.
5. Fan-in stage consolidates via `consolidateFanin`, writes the ledger via `write-gate-findings-log.mjs` BEFORE the visible comment, posts findings (gated by `postFindingsComments`), and posts the `--execution-mode fanout_fanin` verdict — i.e. all four evidences (executionMode, ledger, context artifact, verdict comment) are produced unchanged, and `detect-checkpoint-evidence.mjs` passes for a clean fork-run gate.
6. Both gates (`draft_gate`, `pre_approval_gate`) run the identical workflow shape; the only differences are resolved angles and `blockCleanOnFindingSeverities` (parity).
7. Harness compatibility implemented: forking harness path + documented non-forking fallback. Contract describes both accurately; no overstated fork claim anywhere (`docs/gate-review-sub-loop-contract.md`, `agents/review.agent.md`, `CHANGELOG.md`, `skills/copilot-pr-followup/SKILL.md`, mirrored `.claude/` copies).
8. `verify-fresh-review-context.mjs` and `agents/review.agent.md` reconciled with the decided fork semantics (no false contamination for a legitimately forked reviewer; still fails closed on genuine cross-angle/turn contamination).
9. Tests written first and green: a fork-cache-evidence check (Phase E), execution-model/parity tests, and updated existing gate tests; `npm run verify` (or the narrowest honest subset) green.
10. Docs/contract/CHANGELOG/migration notes updated; v0.3.0 CHANGELOG reflects the true execution model and any feature-flag / migration semantics.
11. Migration decision recorded: drop-in replacement vs. new flagged code path; what stays (`consolidateFanin`, ledger schema, verdict schema) explicitly stated; out-of-scope items listed (§7).
12. The dev-loop dogfoods the reworked gate on its own PR(s) and produces honest `fanout_fanin` evidence (and fork-cache evidence on the forking harness).

---

## 6. Phased breakdown

Ordered; A is gated by the RFC in §10. Each phase is a separate PR-sized slice.

- **Phase A — Workflow gate-fanout script + context-fork.** Implement the `gate-fanout` Workflow (`context-builder stage → parallel([forked reviewers]) → fan-in`). Context-builder loads diff + adjacent code once and writes the existing artifact; reviewers fork-inherit. Gate of this phase: empirically confirm the Workflow tool's fork actually inherits context (cache-hit/shared-context). If it cannot, STOP and escalate (§10 hard blocker) — do not paper over.
- **Phase B — Evidence/ledger/verdict wiring parity.** Wire the fan-in stage to produce the four required evidences unchanged (`fanout_fanin` executionMode, head-SHA ledger via `write-gate-findings-log.mjs`, the gate-context artifact, the verdict comment). Confirm `detect-checkpoint-evidence.mjs`/`buildFanoutEnforcement` pass on a clean fork-run for both gates. Keep `consolidateFanin`/ledger/verdict schemas untouched.
- **Phase C — Harness compat + fallback.** Implement harness detection and the non-forking fallback (independent reviewers reading the artifact). Optionally add an honest execution-strategy field (`forked`/`independent`) to gate evidence (Q3). Reconcile `verify-fresh-review-context.mjs` + `agents/review.agent.md` fresh-context semantics with the §10 decision so forked reviewers don't false-positive on contamination.
- **Phase D — Contract/doc rewrite + remove overstated fork claims.** Rewrite `docs/gate-review-sub-loop-contract.md` to describe the real per-harness model; fix the "fork" vs "fresh context, do not fork" contradiction; update `CHANGELOG.md` (v0.3.0 lines 9–12), `skills/copilot-pr-followup/SKILL.md` §gate procedure, `agents/review.agent.md`, and mirror into `.claude/` copies. Record the migration decision (§5 DoD 11).
- **Phase E — Tests incl. fork-cache-evidence check.** Tests-first: a check that demonstrates forked reviewers inherited context (cache-hit / shared-context evidence per AC2) on the forking harness; execution-model + both-gate parity tests; the documented-fallback path test; updates to existing gate tests. Wire into CI.

---

## 7. Non-goals

- Re-implementing or changing `consolidateFanin`, `planFanoutBatches`, `toFindingsLogShape`, the ledger schema (`write-gate-findings-log.mjs`), or the verdict schema (`upsert-checkpoint-verdict.mjs`). These stay as-is.
- Changing the dynamic angle resolver (`resolveGateAnglesDynamic`), the mandatory-angle floor, `excludeAngles`, or `gates.maxFanoutReviewers` semantics.
- Changing the pre-merge enforcement policy (`gates.requireFanoutEvidence` default-on / opt-out) or the four required evidences themselves.
- Changing the gate-context artifact JSON schema or its deterministic paths (producer/consumer round-trip stays stable) beyond, at most, an additive honest execution-strategy field.
- Broadening the review angle set, adding new angles, or changing reviewer personas/prompts (#885/#886 scope).
- Building a generic Workflow framework beyond the single `gate-fanout` workflow needed here.
- Changing the draft-gate one-time skip rule, CI prerequisites, board sync, or the broader PR lifecycle.

---

## 8. Tests to write first

1. **Fork-cache-evidence check (AC2, Phase E):** on the forking harness, assert each forked reviewer's run records a cache-hit / shared-context marker proving it inherited the context-builder's loaded diff/adjacent code (not a fresh re-read). Define the evidence shape and a deterministic assertion. (If fork-inheritance is unverifiable in this environment, this is the §10 hard blocker, surfaced here as a failing/red test.)
2. **Evidence parity (Phase B):** simulate a clean fork-run for `draft_gate` and `pre_approval_gate`; assert `detect-checkpoint-evidence.mjs` / `buildPreMergeGateCheck` + `buildFanoutEnforcement` pass with `executionMode: fanout_fanin` and a head-SHA ledger present. Extend `test/github/detect-checkpoint-evidence.test.mjs`.
3. **Workflow shape / orchestration (Phase A):** assert the workflow runs stages in order (context-builder → parallel reviewers → fan-in), forks one reviewer per resolved angle bounded by `resolveMaxFanoutReviewers`, and batches overflow via `planFanoutBatches` with `degraded` recorded.
4. **Both-gate parity (Phase A/B):** assert identical workflow shape for both gates; only angles + `blockCleanOnFindingSeverities` differ.
5. **Fallback path (Phase C):** assert that on a non-forking harness the documented independent-reviewer path runs, produces the same four evidences, and records `independent` (not `forked`) without overstating.
6. **Fresh-context reconciliation (Phase C):** assert a legitimately forked reviewer does NOT false-positive as contaminated under the revised guard, while a genuine cross-angle/turn contamination still fails closed. Extend `verify-fresh-review-context` coverage.
7. **Reuse-unchanged regression:** assert `consolidateFanin`/`toFindingsLogShape`/ledger/verdict outputs are byte-for-byte unchanged for the same inputs (no schema drift). Reuse `packages/core/test/gate-fanin.test.mjs`.

## 9. Validation steps

- `npm run verify` (or the narrowest honest subset for the touched slice).
- Dogfood: run the reworked gate on a real dev-loop PR; confirm honest `fanout_fanin` evidence and (on the forking harness) fork-cache evidence; confirm `detect-checkpoint-evidence.mjs` passes.
- Grep audit: no remaining overstated "fork" claim in `docs/`, `agents/`, `skills/`, `CHANGELOG.md`, `.claude/` that the chosen harness does not actually deliver.

---

## 10. RFC escalation (to parent session / human operator)

Two decisions are RFC-worthy and must NOT be guessed through. Receiving boundary / decision owner: the parent session / human operator. RFC discussion team composition: lead dev, specialized dev, systems architect.

### RFC-1 (HARD BLOCKER) — Can the Workflow tool's fork actually inherit the context-builder's loaded context as a cache-hit, in the harness(es) the dev-loop runs under?

This is the assumption #885 baked in and #895's Option-1 decision rests on. If the Workflow tool's `fork`/`parallel` primitive does NOT deliver real context-inheritance / input-token cache hits for the forked reviewers in the target harness, then Option 1 cannot honor its headline property and the only honest resolution is #895's Option 2 (documented-independent reviewers + corrected contract). Phase A is gated on empirically confirming this. Tradeoff: implementing the whole Workflow rework before confirming fork-inheritance risks building the orchestration and still failing AC2 — so confirmation must come first (it is the Phase A gate and test #1).

### RFC-2 — What does "fresh context" mean for a forked reviewer, and how is the fail-closed fresh-context guard reconciled with fork-inherit?

The current contract/agent/guard mandate fresh context and fail closed on inherited context (§1), which is the opposite of fork-inherit. A forked reviewer inherits the context-builder's loaded read-only diff/adjacent-code context by design. The decision needed: define "fresh" as fresh *conversation/turn state per angle* (no cross-angle finding contamination) while *permitting* inherited *read-only briefing context* — and rework `verify-fresh-review-context.mjs` + `agents/review.agent.md` + the contract accordingly. Tradeoff: loosening the guard risks reintroducing the silent-inline / contaminated-review failure mode epic #867 closed; too strict and forking is impossible. This needs an explicit architecture decision, not an ad-hoc tweak.

---

## 11. Unresolved questions

- Q1: Is `gate-fanout` a one-off Workflow script invoked by the skill, or a reusable named workflow registered with the Workflow tool? (Affects how the SKILL procedure references it.)
- Q2: Migration — drop-in replacement for the current manual fan-out, or a new code path behind a feature flag (e.g. `gates.fanoutStrategy: forked|independent`) with the old path retained during transition? Owner decision needed (default proposal: additive strategy flag, forking when available, documented fallback otherwise).
- Q3: Should gate evidence record an honest execution-strategy field (`forked` vs `independent`) distinct from `executionMode: fanout_fanin`, so the audit trail shows HOW reviewers obtained context without weakening the existing enforcement? (Additive; preferred for honesty per AC3.)
- Q4: Does the Workflow tool run reliably as the background orchestration the gate sub-loop needs under the Claude Code harness specifically, or only under Pi? (Feeds RFC-1 and the fallback scope.)
- Q5: How is fork-cache evidence (AC2) actually surfaced/measured by the harness (token-cache-hit metric vs. a shared-context marker)? The test in §8.1 needs a concrete, deterministic evidence shape.

---

## 12. AC / DoD / Non-goal coverage matrix

Status is `Unverified` for all items: this is a refinement plan; nothing is implemented and RFC-1/RFC-2 are open. Evidence references point at the surfaces a future implementation/review must touch.

| Item | Type | Status | Evidence | Notes |
|---|---|---|---|---|
| Decide and implement the execution model (fork via Workflow, or documented-independent). | AC | Unverified | §3 target model; Phase A/C | Gated by RFC-1. |
| If forking: demonstrate reviewers inherit the context-builder's loaded diff/adjacent-code (cache-hit or shared-context evidence). | AC | Unverified | §8.1 fork-cache check; Phase E | Depends on RFC-1 outcome. |
| `docs/gate-review-sub-loop-contract.md` accurately describes how reviewers actually obtain context, with no overstated fork claim. | AC | Unverified | Phase D; `docs/gate-review-sub-loop-contract.md` | Must fix fork vs "fresh, do not fork" contradiction. |
| v0.3.0 release notes/CHANGELOG reflect the true execution model. | AC | Unverified | `CHANGELOG.md` lines 9–12; Phase D | |
| Gate sub-loop driven through Workflow tool as context-builder → parallel([forked reviewers]) → fan-in for both gates (parity). | AC (derived) | Unverified | §3; Phase A; SKILL.md gate procedure | |
| Evidence/contract parity preserved (fanout_fanin + ledger + context artifact + verdict; consolidateFanin/ledger/verdict schemas unchanged). | AC (derived) | Unverified | §2 table; Phase B; `detect-checkpoint-evidence.mjs` | |
| Harness compatibility explicit; documented fallback; no implied fork that is not happening. | AC (derived) | Unverified | §3 per-harness; Phase C/D | |
| Fresh-context tension resolved by explicit recorded decision. | AC (derived) | Unverified | §10 RFC-2; Phase C | |
| Execution model decided/recorded before code; fresh-vs-fork tension resolved. | DoD | Unverified | §10 | |
| gate-fanout Workflow implemented (context-builder → parallel forked → fan-in). | DoD | Unverified | Phase A | |
| Context-builder loads full diff + adjacent code once; writes existing artifact. | DoD | Unverified | `write-gate-context.mjs`; Phase A | |
| Forked reviewers inherit context, single-angle, read-only, may widen, write per-angle artifact. | DoD | Unverified | `agents/review.agent.md`; Phase A | |
| Fan-in consolidates, writes ledger before comment, posts findings + fanout_fanin verdict; detect-checkpoint-evidence passes. | DoD | Unverified | Phase B; `detect-checkpoint-evidence.mjs` | |
| Both gates run identical workflow shape (parity). | DoD | Unverified | Phase A/B | |
| Harness compat implemented; no overstated fork claim anywhere (incl. .claude mirrors). | DoD | Unverified | Phase C/D | |
| verify-fresh-review-context + review.agent.md reconciled with fork semantics. | DoD | Unverified | Phase C; §10 RFC-2 | |
| Tests-first green incl. fork-cache-evidence + parity; verify green. | DoD | Unverified | §8; Phase E | |
| Docs/contract/CHANGELOG/migration updated; v0.3.0 true model. | DoD | Unverified | Phase D | |
| Migration decision recorded; what stays stated; out-of-scope listed. | DoD | Unverified | §7; Q2 | |
| Dev-loop dogfoods reworked gate; honest evidence produced. | DoD | Unverified | §9 | |
| Do not change consolidateFanin/planFanoutBatches/toFindingsLogShape/ledger/verdict schemas. | Non-goal | Unverified | §7 | |
| Do not change dynamic angle resolver / mandatory floor / excludeAngles / maxFanoutReviewers semantics. | Non-goal | Unverified | §7 | |
| Do not change requireFanoutEvidence policy or the four required evidences. | Non-goal | Unverified | §7 | |
| Do not change gate-context artifact schema/paths (beyond at most an additive strategy field). | Non-goal | Unverified | §7; Q3 | |
| Do not broaden angle set / personas / prompts. | Non-goal | Unverified | §7 | |
| Do not build a generic Workflow framework beyond gate-fanout. | Non-goal | Unverified | §7 | |
| Do not change draft-gate skip rule / CI prereqs / board sync / PR lifecycle. | Non-goal | Unverified | §7 | |

Completion note: per the refinement quality bar, this plan is NOT "ready to implement" — every matrix row is `Unverified` and RFC-1 (hard blocker) + RFC-2 are open. RFC-1 must be answered before Phase A starts; an empirical failure of RFC-1 collapses the plan to Option 2 (documented-independent) and would make AC2 unachievable as written.
