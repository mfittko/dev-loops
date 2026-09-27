# Workflow Handoff — Derivation Contract

> **Status:** This document defines the **contract** for the
> `buildDevLoopHandoffEnvelope()` function in `@dev-loops/core`.
> Agents should read the envelope as their first artifact and then load
> only the listed `requiredReads` before executing `nextAction`.

## Authoritative sources

Every field in the handoff envelope is derived from authoritative sources as shown below. No field uses a hard-coded magic string or prose
template.

| Source | Fields derived |
|---|---|
| Resolver output (`resolve-dev-loop-startup.mjs` bundle) | `target`, `nextAction`, `requiredReads`, `executionMode` |
| Caller options (`repoRoot`, `worktreeCwd`) | `cwd` |
| Gate state (detectors) + strategy defaults | `currentGate`; `worktreeRequired` except for terminal reconciliation |
| Settings (`.devloops` at repo root + `defaults.yaml`) | `gateConfig`, `stopRules` except for terminal reconciliation, `asyncStartMode`, `requireDraftFirst`, `maxCopilotRounds` |
| Terminal reconciliation invariant (`needs_reconcile` / `fail_closed_reconcile` / `null`) | `worktreeRequired=false`, canonical reconcile acceptance (criterion, evidence, and finalization limit), `stopRules=["reconcile"]` plus `"merge"` only when `humanMergeOnly` requires it |
| Gate state (detectors) | `gateState.{currentHeadSha, ciStatus, unresolvedThreadCount, copilotRoundCount}` (the volatile tail — see below) |
| Envelope builder (timestamp) | `gateState.derivedAt` (build time, not detector-derived) |
| Canonical sanctioned-command map (`scripts/loop/sanctioned-commands.mjs`) | `sanctionedCommands` |

## Sanctioned commands (MANDATORY DEFAULT — issue #1081)

`sanctionedCommands` is a **mandatory default** element of every handoff
envelope. It is the operation → wrapper command map, plus the forbidden and
orchestrator-owned lists (shape in the [Envelope schema](#envelope-schema)).
The `loop build-envelope` CLI injects it into every emitted envelope, so a
spawned dev-loop subagent receives it verbatim without the briefer adding it.

The **single source of truth** is `scripts/loop/sanctioned-commands.mjs` (a
frozen data module). `@dev-loops/core` defines only the envelope SHAPE and
carries whatever `sanctionedCommands` object the consumer supplies. Do not
duplicate the map into prose — reference the module.

A contract test (`test/contracts/sanctioned-commands-exist.test.mjs`) asserts
every mapped wrapper exists on disk and fails closed if one is renamed/removed.

## Acceptance templates

`acceptance.criteria`, `acceptance.evidence`, `acceptance.maxFinalizationTurns`,
and `control.*` are derived from a static strategy+gate mapping table:

| Strategy | Gate | criteria | evidence | maxFinalizationTurns | needsAttentionAfterMs |
|---|---|---|---|---|---|
| `copilot_pr_followup` | `draft` | AC check, scope, coverage, DoD alignment | commands-run, validation-output, review-findings | 4 | 300000 |
| `copilot_pr_followup` | `watch` | Copilot activity detection, no stuck watch | commands-run | 2 | 1800000 |
| `copilot_pr_followup` | `pre-approval` | Full pre-approval gate chain, clean verdict, unresolved threads, CI green | commands-run, validation-output, review-findings, residual-risks | 6 | 300000 |
| `final_approval` | `default` | Gate evidence, human confirmation, CI green | validation-output, manual-notes | 2 | 300000 |
| `local_implementation` | `default` | Phase-acceptance criteria, targeted validation green | commands-run, validation-output, changed-files | 6 | 300000 |
| `issue_intake` | `default` | Contract compliance | commands-run, validation-output | 4 | 300000 |
| `external_pr_followup` | `default` | Contract compliance | commands-run, validation-output | 4 | 300000 |
| `reviewer_fixer` | `default` | Contract compliance | commands-run, validation-output | 4 | 300000 |
| `wait_watch` | `default` | Contract compliance | commands-run, validation-output | 4 | 1800000 |
| `null` | `fail_closed_reconcile` | Reconcile authoritative state before routing | commands-run, validation-output | 1 | 300000 |

Unknown strategy and gate combinations throw an explicit error listing known combos. A resolver result with `routeKind: "needs_reconcile"`, `selectedGate: "fail_closed_reconcile"`, and `selectedStrategy: null` is intentionally accepted as a terminal, actionable envelope; null remains invalid for routed work.

For that terminal reconciliation tuple, the resolver remains the authority for the actual `nextAction`; the builder copies it unchanged. The validator checks the tuple, no-worktree boundary, canonical reconcile stop rules, a required `reconcile` acceptance criterion, and a recognized fail-closed directive prefix (including the router's canonical `Stop and reconcile ...` action). A wrapped startup result must carry `bundleKind: needs_reconcile` at both levels, the outer display key `selectedStrategy: none`, and nested `selectedStrategy: null`; an unwrapped canonical bundle remains supported. No worktree is required. The stop rules follow the terminal exception in [Stop rules](#stop-rules).

## Stop rules

The terminal reconciliation tuple always uses `["reconcile"]`, plus `"merge"` only when required by `humanMergeOnly`. It ignores configured `autonomy.stopAt` and ordinary strategy defaults, because no strategy may execute until reconciliation succeeds.

Otherwise stop rules are derived from `settings.autonomy.stopAt` when present.
When absent, strategy defaults apply:

| Strategy | Default stop rules |
|---|---|
| `copilot_pr_followup` | `["draft-pr", "merge"]` |
| `issue_intake` | `["merge"]` |
| `external_pr_followup` | `["merge"]` |
| `reviewer_fixer` | `["merge"]` |
| `wait_watch` | `["merge"]` |
| `final_approval` | `["merge"]` |
| `local_implementation` | `[]` (auto-continue) |

## Envelope schema

```typescript
interface HandoffEnvelope {
  handoffVersion: 1;

  target: {
    kind: "issue" | "pr" | "local_branch" | "local_phase";
    repo: string;
    issue?: number;
    pr?: number;
    linkedPr?: number;
    branch?: string;
    phase?: string;
  };

  currentGate: string;
  maxCopilotRounds: number;
  executionMode: "bounded_handoff" | "durable_auto";
  routeKind?: "needs_reconcile"; // present on terminal reconciliation envelopes
  selectedStrategy?: null;       // present only with routeKind=needs_reconcile

  nextAction: string;
  requiredReads: string[];

  gateConfig?: {
    angles: string[];
    excludeAngles?: string[];
    blockCleanOnFindingSeverities: string[];
    requireCi: boolean;
  };

  stopRules: string[];
  asyncStartMode: "required" | "allowed";
  requireDraftFirst: boolean;

  cwd: string | null;
  worktreeRequired: boolean;

  acceptance: {
    criteria: Array<{ id: string; must: string; severity: "required" | "recommended" }>;
    evidence: string[];
    maxFinalizationTurns: number;
  };

  control: {
    needsAttentionAfterMs: number;
    activeNoticeAfterMs: number;
  };

  overrides?: {
    mergeAuthorized?: boolean;
    preferLocal?: boolean;
    scopeConstraint?: string;
    customStopAt?: string;
  };

  // Mandatory default (issue #1081). Source: scripts/loop/sanctioned-commands.mjs
  sanctionedCommands?: {
    reads: Record<string, string>;         // operation → wrapper path (some also accept `loop info`)
    edits: Record<string, string>;
    lifecycle: Record<string, string>;
    forbidden: string[];                   // raw `gh pr view/checks/edit`, `node -e`, `python -c`, transcript tailing, sleep-poll loops
    orchestratorOwned: string[];           // pr merge via merge-pr.mjs (raw `gh pr merge` forbidden), board status transitions — never done by a subagent
  };

  // #1462: the ONLY per-round-varying block, ALWAYS LAST. Treat gateState as
  // volatile: read it last, or re-derive it fresh via detectors. Never add a
  // per-round-varying field above this block.
  gateState: {
    derivedAt: string;         // ISO timestamp
    currentHeadSha: string | null;
    ciStatus: string | null;
    unresolvedThreadCount: number;
    copilotRoundCount: number;
  };
}
```

## Agent consumption pattern

1. Read the handoff envelope as the first artifact.
2. Read every path listed in `requiredReads` (in order).
3. Execute `nextAction`.
4. Respect `stopRules` — do not proceed past a gated stop point without authorization.
5. Use `acceptance` to self-validate before declaring completion.
6. Use `sanctionedCommands` as the authoritative operation → wrapper map: never call a raw `gh`/`node -e`/`python -c` for an operation the map covers, and never perform an `orchestratorOwned` action.
7. Treat `gateState` as **volatile and last**: read it after the stable body + `requiredReads`. Its detector-sourced fields (head SHA, CI status, thread/round counts) may be re-derived fresh via detectors right before acting; `derivedAt` is a build timestamp, not detector-derived. Never rely on `gateState` being cached.

## Byte-stable prefix (issue #1462)

Everything in the envelope **above `gateState`** is derived only from the target,
strategy, gate, and settings — it is **byte-identical across builds/rounds for the
same target+gate**. All per-round-varying values (`derivedAt`, the head SHA, CI
status, thread/round counts) live in the trailing `gateState` block, and nothing
else may.

Fresh review subagents spawned each round can reuse this stable prefix.
**Contract rule:** never add a field that
varies per round anywhere except inside `gateState`. The envelope test
(`#1462: the envelope minus gateState is byte-stable ...`) checks byte stability.

## Backward compatibility

The `acceptance` block maps 1:1 into the existing `subagent()` acceptance
contract shape. When the envelope is present, no separate prose task
parameter is required.

Read the per-round fields (`derivedAt`, `currentHeadSha`, `ciStatus`,
`unresolvedThreadCount`, `copilotRoundCount`) from `envelope.gateState.*`.
`handoffVersion` stays `1`, because envelopes are ephemeral and never persisted.

## Non-goals

- This contract does not define dispatch mechanics.
- This contract does not define UI/UX for envelope display.
- This contract does not modify the `subagent()` API itself.
