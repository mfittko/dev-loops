# Retrospective checkpoint contract

This document defines the enforcement seam for the post-run behavioral retrospective checkpoint after qualifying async `dev-loop` completions in this repository. Whether a missing checkpoint blocks the next qualifying start/resume is controlled by `.devloops` at repo root `workflow.requireRetrospective`; shipped defaults remain permissive and this repo opts in.

## Relationship to formal dev mode

Formal local dev mode and the required post-run behavioral retrospective are related but distinct:

| Requirement | Scope |
|---|---|
| **Formal local dev mode** | Local implementation/self-improvement work; explicitly scoped in [Dev Loop Skill](../dev-loop/SKILL.md) |
| **Required post-run behavioral retrospective** | Every qualifying async GitHub-first `dev-loop` completion in this repo |

Routed GitHub-first async `dev-loop` runs do **not** need to be in full formal local dev mode. When `workflow.requireRetrospective` is enabled, they **do** require the retrospective checkpoint before the next qualifying start/resume.

## Qualifying completions

A qualifying async `dev-loop` completion is one that:
- routes through a GitHub-first Copilot-owned strategy gate, and
- has `routeKind === "route"` (inspect/status-only results do not qualify).

Qualifying gates:

| Gate | Strategy | Description |
|---|---|---|
| `copilot_pr_followup` | Copilot PR follow-up | Primary routed GitHub-first async path |
| `issue_intake` | Issue intake | Copilot-first issue assignment path |

The authoritative classification function is `isQualifyingAsyncCompletion(routingResult)` in `packages/core/src/loop/retrospective-checkpoint.mjs`.

## Checkpoint states

A fresh session can determine the status of the required retrospective by reading `.pi/dev-loop-retrospective-checkpoint.json`:

| File state | Mapped checkpoint state | Meaning |
|---|---|---|
| File absent | `RETROSPECTIVE_CHECKPOINT_STATE.NONE` | No qualifying completion has occurred; no requirement |
| `{ "state": "required" }` | `RETROSPECTIVE_CHECKPOINT_STATE.MISSING` | Qualifying completion detected; retrospective pending |
| `{ "state": "complete" }` | `RETROSPECTIVE_CHECKPOINT_STATE.COMPLETE` | Retrospective recorded; requirement satisfied |
| `{ "state": "skipped" }` | `RETROSPECTIVE_CHECKPOINT_STATE.SKIPPED` | Explicitly skipped with reason; requirement satisfied |

## Enforcement gate

The enforcement seam is the pure function `evaluateRetrospectiveGate` in `packages/core/src/loop/retrospective-checkpoint.mjs`. The checkpoint artifact may still exist even when enforcement is disabled; callers must first consult `workflow.requireRetrospective` to decide whether the checkpoint should block the next qualifying routed start/resume or remain advisory-only.

For convenience, the public routing helpers in `packages/core/src/loop/public-dev-loop-routing.mjs` also accept an optional `retrospectiveCheckpointState` input and apply the same gate internally before returning routed start/resume/status results. Callers should only pass that input when `workflow.requireRetrospective` is enabled for the active repo/workflow posture.

### Inputs

```js
evaluateRetrospectiveGate({
  checkpointState,  // one of RETROSPECTIVE_CHECKPOINT_STATE
  proposedRouting,  // result from evaluatePublicDevLoopRouting()
})
```

### Outputs

- **Pass-through** (proposed routing returned unchanged) when:
  - `checkpointState` is `none`, `complete`, or `skipped`
  - `proposedRouting` is already `stop`, `needs_reconcile`, or `inspect`
- **Fail-closed** (`needs_reconcile` result) when:
  - `checkpointState` is `missing`
  - `checkpointState` is unrecognized

### Caller contract

Callers have two supported integration options:

#### Option A — direct public-routing helper integration (preferred)

1. Read `.pi/dev-loop-retrospective-checkpoint.json` (if it exists).
2. Map the file contents to a `RETROSPECTIVE_CHECKPOINT_STATE` value.
3. Pass that value as `retrospectiveCheckpointState` to one of:
   - `evaluatePublicDevLoopRouting(...)`
   - `resolveAuthoritativeStartupResumeBundle(...)`
   - `resolveAuthoritativeDevLoopStatus(...)`
4. Use the returned result directly. When enforcement is enabled and the checkpoint is missing, these helpers fail closed to `needs_reconcile`.

#### Option B — explicit manual gate composition

1. Read `.pi/dev-loop-retrospective-checkpoint.json` (if it exists).
2. Map the file contents to a `RETROSPECTIVE_CHECKPOINT_STATE` value.
3. Call `evaluatePublicDevLoopRouting(...)` to get the proposed routing.
4. Call `evaluateRetrospectiveGate({ checkpointState, proposedRouting })`.
5. Use the gate result (not the raw routing result) as the effective routing decision when enforcement is enabled; otherwise keep the raw routing result and treat the checkpoint artifact as advisory context only.

If the gate result is `needs_reconcile`, the caller must not proceed with the proposed routing. The `nextAction` field instructs the operator to complete or explicitly skip the retrospective.

## Merge gate (`requireRetrospectiveGate`)

When `workflow.requireRetrospectiveGate` is enabled in `.devloops` at repo root, merge-ready progression is blocked after `pre_approval_gate` unless the retrospective checkpoint:
- has `state: "complete"`
- includes a `behavioralReview` with `mergeApproved: true`, `followedWorkingAgreement` (boolean), `gateQualityAcceptable` (boolean), and `drifts` (array)
- includes `mergeRecommendation` (non-empty string)
- **(developer mode only)** includes `behavioralReview.internalToolingOnly: true` (boolean) and `behavioralReview.rawCallViolations: []` (empty array) — see **Internal-tooling-only rule** below

The enforcement function is `evaluateRetrospectiveMergeApproval(checkpoint, { developerMode })` in `packages/core/src/loop/pr-gate-coordination.mjs`, called from `evaluatePrGateCoordination` at each merge-ready boundary.

### Internal-tooling-only rule (issue #982) — DEVELOPER MODE ONLY, opt-in

This is a **developer-mode** retro step: it enforces the dev-loops maintainers' own dogfooding discipline and is **opt-in** via `workflow.requireRetrospectiveInternalTooling` (**default OFF**). **Consumers of the dev-loops extension are never blocked by it** — a consumer may legitimately use raw `gh`/`python`/`node -e` in their own workflow, so when the flag is OFF (the consumer default) the `internalToolingOnly`/`rawCallViolations` fields are neither required nor enforced, and a complete, merge-approved checkpoint passes exactly as it would without these fields. The check only requires and enforces them when `workflow.requireRetrospectiveInternalTooling: true` (the dev-loops repo opts in via its own repo-root `.devloops`).

When developer mode is ON, the loop's own execution must use internal dev-loops tooling only. **Agent-level top-level raw calls are all the same breach and all block the merge gate:**

- `gh ...` (including `gh api`, `gh ... --jq`) — use `gate capture-threads`, `gate reply-resolve`, `dev-loops loop info`, `queue …`, or a `node scripts/...` wrapper instead
- `python` / `python3` — parse JSON with the tool's `--jq`/built-in output, not an inline Python one-liner
- `node -e` / `node --eval` — inline eval to read/parse tool output is a violation; `node scripts/foo.mjs` is **not**

**Allowed (NOT violations):** dev-loops subcommands, and `node scripts/*.mjs` invocations — those scripts legitimately call `gh`/GraphQL internally; that is the tooling. The rule targets the agent's own top-level shell calls, not a script's internals.

The retrospective author records the result in the checkpoint:
- `behavioralReview.internalToolingOnly` (boolean) — `true` only when the run used internal tooling throughout
- `behavioralReview.rawCallViolations` (array of strings) — one entry per agent-level raw call; empty when clean

**Fail-closed (developer mode only):** when `requireRetrospectiveInternalTooling` is ON, the merge gate blocks (`retrospective_gate_pending`) if `internalToolingOnly` is not `true` **OR** `rawCallViolations` is missing/non-empty. `state: "complete"` alone is **not** sufficient — a clean tooling record is also required. When the flag is OFF (consumer default) this check is inert: it never blocks, even for a checkpoint that omits the fields or records a violation.

**Back-compat:** an OLD checkpoint that omits `internalToolingOnly`/`rawCallViolations` only fails closed in developer mode; with the flag OFF (consumer default) it passes unchanged. Re-record the retrospective with the new fields to clear a developer-mode block.

**Write-op allowlist (verifier only):** `gh pr merge`, `gh pr ready`, `gh issue create`, `gh issue edit` have no internal wrapper today. The deterministic verifier (below) records these as `allowedWriteOps` rather than violations so the gate is not blocked forever on an unavoidable gap. Close the gap with a wrapper to remove an entry. The gate itself still fails on any non-empty `rawCallViolations` the author records.

### Deterministic verifier

`node scripts/loop/check-retro-tooling.mjs [--transcript <path>] [--json]` reads a newline-delimited transcript of the shell commands the agent ran (one top-level command per line, via `--transcript` or stdin) and reports agent-level raw `gh`/`python`/`python3`/`node -e`/`node --eval` calls. Use it to derive the `rawCallViolations` array the retrospective author records. Exit code `1` when violations are found, `0` when clean. The pure `analyzeTranscript(transcript)` export returns `{ violations, allowedWriteOps, internalToolingOnly }`.

Matching rules: a tool name at the start of a command segment (start of line, or after `&&`/`||`/`|`/`;`); `node` is a violation only with `-e`/`--eval`. Before classifying, the verifier normalizes the segment head — it strips leading `NAME=value` env-assignment prefixes (`GH_TOKEN=x gh api`), strips a leading wrapper binary from `{sudo, env, xargs, time, nice, command}` (`sudo gh api`, `xargs gh api`), and reduces a path-prefixed binary to its basename (`./node_modules/.bin/gh`, `/usr/bin/python3`) — so the common prefixed/wrapped raw-call forms are caught. Known limitation: it does NOT fully parse shell quoting/substitution. A separator inside a quoted argument can over-report; deeply obfuscated calls (command substitution `$(...)`, aliases, `eval`) may evade it — prefer single-line, single-purpose commands in transcripts.

### Merge gate states

| Retrospective state | Merge gate result |
|---|---|
| No checkpoint file | Blocked: `retrospective_gate_pending` |
| `state: "complete"` with `mergeApproved: true` and valid base fields (consumer default; internal-tooling check OFF) | Allowed: proceeds to `FINAL_APPROVAL_READY` |
| `state: "complete"` without `mergeApproved: true` | Blocked |
| **Developer mode ON** + `internalToolingOnly` not `true`, or `rawCallViolations` missing/non-empty | Blocked |
| **Developer mode OFF** (consumer default) + missing `internalToolingOnly`/`rawCallViolations` or a recorded violation | Allowed (check is inert) |
| Missing base required fields (`followedWorkingAgreement`, `gateQualityAcceptable`, `drifts`, `mergeRecommendation`) | Blocked |
| `state: "skipped"` or `state: "required"` | Blocked |

### Configuration

```yaml
# .devloops at repo root
workflow:
  requireRetrospective: true                  # startup/resume gate
  requireRetrospectiveGate: true               # merge gate after pre_approval_gate
  requireRetrospectiveInternalTooling: true    # developer-mode internal-tooling-only check (default OFF; consumers leave unset)
```

## Durable artifact format

The checkpoint file is written by `.pi/extensions/dev-loop-behavioral-review.ts` when it observes the standard async `dev-loop` completion message. The extension trigger is message-based; qualifying-path policy is enforced by the checkpoint gate and repo contract, not by deep route inspection in the extension itself:

### On observed async dev-loop completion message (written automatically by extension)

```json
{
  "state": "required",
  "triggeredAt": "2026-05-29T16:00:00.000Z"
}
```

### After retrospective is done (written by operator or skill)

A minimal completion clears the startup gate. To also clear the **merge gate**
(`requireRetrospectiveGate`), include the `behavioralReview`, `gateQuality`, and
`mergeRecommendation` fields:

```json
{
  "state": "complete",
  "completedAt": "2026-05-29T16:30:00.000Z",
  "notes": "Loop followed working agreement; minor drift on thread resolution.",
  "gateQuality": "Real gates with concrete findings and follow-through.",
  "mergeRecommendation": "Merge approved — all gates passed clean.",
  "behavioralReview": {
    "mergeApproved": true,
    "followedWorkingAgreement": true,
    "gateQualityAcceptable": true,
    "drifts": [],
    "internalToolingOnly": true,
    "rawCallViolations": []
  }
}
```

### Explicit skip with reason

```json
{
  "state": "skipped",
  "skippedAt": "2026-05-29T16:30:00.000Z",
  "reason": "Trivial documentation-only change; no post-run audit needed."
}
```

## Authoritative source locations

| Artifact | Location |
|---|---|
| Checkpoint state machine | `packages/core/src/loop/retrospective-checkpoint.mjs` (internal core module; not part of the public package exports surface) |
| Merge gate evaluator | `packages/core/src/loop/pr-gate-coordination.mjs` — `evaluateRetrospectiveMergeApproval` |
| Internal-tooling verifier | `scripts/loop/check-retro-tooling.mjs` (+ `test/loop/check-retro-tooling.test.mjs`) |
| Tests | `packages/core/test/retrospective-checkpoint.test.mjs`, `packages/core/test/pr-gate-coordination.test.mjs` |
| Extension (writes required marker, fires review prompt) | `.pi/extensions/dev-loop-behavioral-review.ts` |
| Checkpoint file | `.pi/dev-loop-retrospective-checkpoint.json` |
| AGENTS.md repo contract | [Agent Instructions](../../AGENTS.md) — concise repo contract and working rules |
