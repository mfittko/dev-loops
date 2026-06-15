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
| Gate state (detectors) + strategy defaults | `currentGate`, `worktreeRequired` |
| Settings (`.devloops` at repo root + `defaults.yaml`) | `gateConfig`, `stopRules`, `asyncStartMode`, `requireDraftFirst`, `maxCopilotRounds` |
| Gate state (detectors) | `currentHeadSha`, `ciStatus`, `unresolvedThreadCount`, `copilotRoundCount` |

## Acceptance templates

`acceptance.criteria`, `acceptance.evidence`, `acceptance.maxFinalizationTurns`,
and `control.*` are derived from a static strategy+gate mapping table:

| Strategy | Gate | criteria | evidence | maxFinalizationTurns | needsAttentionAfterMs |
|---|---|---|---|---|---|
| `copilot_pr_followup` | `draft` | AC check, scope, coverage, DoD alignment | commands-run, validation-output, review-findings | 4 | 300000 |
| `copilot_pr_followup` | `watch` | Copilot activity detection, no stuck watch | commands-run | 2 | 1800000 |
| `copilot_pr_followup` | `pre-approval` | Full pre-approval gate chain, clean verdict, unresolved threads, CI green | commands-run, validation-output, review-findings, residual-risks | 6 | 300000 |
| `final_approval` | `default` | Gate evidence, human confirmation, CI green | validation-output, manual-notes | 2 | 300000 |
| `local_implementation` | `default` | Phase-acceptance criteria, verify green | commands-run, validation-output, changed-files | 6 | 300000 |
| `issue_intake` | `default` | Contract compliance | commands-run, validation-output | 4 | 300000 |
| `external_pr_followup` | `default` | Contract compliance | commands-run, validation-output | 4 | 300000 |
| `reviewer_fixer` | `default` | Contract compliance | commands-run, validation-output | 4 | 300000 |
| `wait_watch` | `default` | Contract compliance | commands-run, validation-output | 4 | 1800000 |

Unknown strategy+gate combinations throw an explicit error listing known combos.

## Stop rules

Stop rules are derived from `settings.autonomy.stopAt` when present.
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
  derivedAt: string; // ISO timestamp

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
  currentHeadSha: string | null;
  ciStatus: string | null;
  unresolvedThreadCount: number;
  copilotRoundCount: number;
  maxCopilotRounds: number;
  executionMode: "bounded_handoff" | "durable_auto";

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
}
```

## Agent consumption pattern

1. Read the handoff envelope as the first artifact.
2. Read every path listed in `requiredReads` (in order).
3. Execute `nextAction`.
4. Respect `stopRules` — do not proceed past a gated stop point without authorization.
5. Use `acceptance` to self-validate before declaring completion.

## Backward compatibility

The `acceptance` block maps 1:1 into the existing `subagent()` acceptance
contract shape. When the envelope is present, no separate prose task
parameter is required.

## Non-goals

- This contract does not define dispatch mechanics.
- This contract does not define UI/UX for envelope display.
- This contract does not modify the `subagent()` API itself.
