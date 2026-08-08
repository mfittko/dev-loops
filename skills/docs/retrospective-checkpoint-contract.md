# Retrospective checkpoint contract

Canonical owner for the enforcement seam of the post-run behavioral retrospective checkpoint after qualifying async `dev-loop` completions in this repository.

<!-- rule: RETRO-ENFORCEMENT-CONFIG-GATED -->
Whether a missing checkpoint blocks the next qualifying start/resume MUST be controlled by `.devloops` at repo root `workflow.requireRetrospective`; shipped defaults remain permissive and this repo opts in.

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

<!-- rule: RETRO-GATE-FAIL-CLOSED -->
If the gate result is `needs_reconcile`, the caller MUST NOT proceed with the proposed routing. The `nextAction` field instructs the operator to complete or explicitly skip the retrospective.

## Advisory findings — never a merge gate (issue #1077, Reading B)

<!-- rule: RETRO-ADVISORY-NEVER-GATE -->
The retrospective is **advisory**: it runs, records flagged raw-call / discipline
observations honestly, and passes them back to the conductor (main agent) to
**decide** what to do with them — but it MUST NOT block a merge or any PR-lifecycle
transition of the current run. The pre-merge retrospective gate (`evaluateRetrospectiveMergeApproval`
and the `requireRetrospectiveGate` / `requireRetrospectiveInternalTooling` config
keys) has been **removed**. There is no `retrospective_gate_pending` / `blocked`
disposition on account of the internal-tooling raw-call record.

### How findings travel (Reading B)

<!-- rule: RETRO-FINDINGS-ENVELOPE-CARRY -->
1. **Deterministic return contract.** The loop subagent's handoff envelope MUST carry
   the retrospective findings as a structured `retrospectiveFindings` field — the
   `check-retro-tooling.mjs` JSON output (`{ internalToolingOnly, rawCallViolations,
   allowedWriteOps }`), not prose. The conductor reads that field. This is a hard
   contract; see [Workflow Handoff Contract](./workflow-handoff-contract.md).
2. **Durability — advisory PR comment.** The conductor posts a single advisory PR
   comment carrying the findings (`rawCallViolations`, `internalToolingOnly`,
   `allowedWriteOps`). Durable and on-GitHub, but **not a gate**. No disk artifact
   is written for retrospective *findings*.
3. **No config.** There is nothing to configure: the retrospective always runs and
   always returns findings. `requireRetrospectiveGate` and
   `requireRetrospectiveInternalTooling` no longer exist.

A PR that is otherwise green becomes merge-ready with the violations **recorded**,
not blocked. The conductor may note them, open a follow-up, coach — or ignore.

### Internal-tooling-only rule (issue #982) — now advisory

This rule records the dev-loops maintainers' own dogfooding discipline: the loop's
own execution should use internal dev-loops tooling, not agent-level raw
`gh`/`python`/`node -e` escape hatches. **It no longer blocks.** The flagged calls
are reported as advisory findings via the envelope + PR comment.

**Flagged as raw-call violations:** `gh ...` (including `gh api`, `gh ... --jq`),
`python` / `python3`, `node -e` / `node --eval` (inline eval). **Allowed (NOT
violations):** dev-loops subcommands and `node scripts/*.mjs` invocations — those
scripts legitimately call `gh`/GraphQL internally; that is the tooling. The rule
targets the agent's own top-level shell calls, not a script's internals.

**Write-op allowlist (verifier only):** only `gh pr merge` and `gh pr ready` have
no internal wrapper today; the verifier records those as `allowedWriteOps` rather
than violations so the gap is surfaced distinctly, not as a breach. Ops that DO
have a sanctioned wrapper — `gh issue create` (`scripts/github/create-issue.mjs`),
`gh issue edit` (`scripts/github/edit-issue.mjs`), `gh label create`
(`scripts/github/create-label.mjs`) — are NOT allowlisted, so a raw agent-level
call is flagged as a violation. The verifier only ever classifies the agent's own
top-level shell commands, never a wrapper's internal subprocess, so removing a
wrapped op from the allowlist produces no false positives. Close a remaining gap
with a wrapper to remove its allowlist entry. None of these block anything.

**Inline-interpreter check item:** the raw-call scan below mechanically catches
`node -e`/`python3 -c`/heredoc calls as a `rawCallViolations` entry — the same
class barred by `OPS-NO-INLINE-INTERPRETER` in
[Copilot loop operations](copilot-loop-operations.md). This is an addition to
what the retrospective records, not a new gate: `RETRO-ADVISORY-NEVER-GATE`
semantics are unchanged.

### Deterministic verifier (findings-producer)

`node scripts/loop/check-retro-tooling.mjs [--transcript <path>] [--json]` reads a
newline-delimited transcript of the shell commands the agent ran (one top-level
command per line, via `--transcript` or stdin) and reports agent-level raw
`gh`/`python`/`python3`/`node -e`/`node --eval` calls. It is a **findings-producer**:
its JSON output (`{ ok, internalToolingOnly, rawCallViolations, allowedWriteOps }`)
is returned to the conductor via the envelope's `retrospectiveFindings` field (the
envelope carries the normalized shape `{ internalToolingOnly, rawCallViolations,
allowedWriteOps }` — the redundant `ok` flag is dropped by normalization) — it
is **not** written to a checkpoint and **not** a gate. Exit code `1` when violations
are found, `0` when clean. The pure `analyzeTranscript(transcript)` export returns
`{ violations, allowedWriteOps, internalToolingOnly }`.

Matching rules: a tool name at the start of a command segment (start of line, or
after `&&`/`||`/`|`/`;`); `node` is a violation only with `-e`/`--eval`. Before
classifying, the verifier normalizes the segment head — it strips leading
`NAME=value` env-assignment prefixes (`GH_TOKEN=x gh api`), strips a leading
wrapper binary from `{sudo, env, xargs, time, nice, command}` (`sudo gh api`,
`xargs gh api`), and reduces a path-prefixed binary to its basename
(`./node_modules/.bin/gh`, `/usr/bin/python3`) — so the common prefixed/wrapped
raw-call forms are caught. Known limitation: it does NOT fully parse shell
quoting/substitution. A separator inside a quoted argument can over-report; deeply
obfuscated calls (command substitution `$(...)`, aliases, `eval`) may evade it —
prefer single-line, single-purpose commands in transcripts.

### Lifecycle reconciliation

The retrospective is described consistently as a **post-merge / advisory
reflection**, never a pre-merge blocker. The former contradiction —
`lifecycle-state.mjs` documenting the retro as a post-merge write while
`pr-gate-coordination.mjs` enforced it pre-merge — is resolved by removing the
pre-merge gate: the merge lifecycle step proceeds, and the retrospective is an
advisory reflection whose findings reach the conductor via the envelope.

## Cycle scoping — a checkpoint discharges exactly one qualifying completion

<!-- rule: RETRO-CHECKPOINT-CYCLE-SCOPED -->
`requireRetrospective` is not a one-time gate: a `complete` (or `skipped`) checkpoint MUST be scoped to the exact qualifying completion it discharges, not treated as satisfying every later one forever. The durable artifact carries an `identity` — at minimum `{ repo, prNumber, mergeCommit }` — alongside its `state`, and both arming and completion write that identity so a later reader can tell WHICH cycle it covers.

- **Arming.** `resolve-dev-loop-startup.mjs` detects a qualifying completion (a merged run whose resolved gate is in `RETROSPECTIVE_QUALIFYING_GATES`) and automatically writes `state: "required"` with `triggeredAt` and the cycle `identity` — no manual `checkpoint-contract` invocation is required for the gate to fire. Arming is idempotent: it is a no-op once the durable artifact's `identity` already matches the observed completion, so re-resolving an already-discharged merged PR never re-blocks it.
- **Completion / skip.** Recording `complete` or `skipped` (via `checkpoint-contract.mjs --repo <owner/name> --pr <n> --merge-commit <sha>`, alongside `--state`/`--notes`/`--reason`) SHOULD carry forward the same `identity` the `required` record armed, so the artifact states which cycle it discharged. `skipped` is scoped the same way — an explicit, reasoned escape hatch for one cycle, not a standing exemption.
- **Fail-closed backstop.** The pure resolver (`resolveCheckpointStateFromArtifact` in `packages/core/src/loop/retrospective-checkpoint.mjs`) treats a `complete` checkpoint whose recorded `identity` does not match the latest observed qualifying completion as `MISSING`, not `COMPLETE` — even if arming was somehow bypassed for the newer cycle. Arming is the primary mechanism; this is the backstop for when it is not.
- **Unaffected repos.** A repo with `workflow.requireRetrospective` unset or `false` never has this artifact written for it — the arming step itself checks the config before touching disk.

## Durable artifact format

The checkpoint file is written by two mechanisms:

- **`resolve-dev-loop-startup.mjs`** (authoritative, deterministic): arms `state: "required"` automatically at the qualifying-completion seam described above.
- **`.pi/extensions/dev-loop-behavioral-review.ts`** (best-effort, Pi-harness-specific): fires when it observes the standard async `dev-loop` completion message and writes the same `required` marker as a secondary trigger. Its message-based detection does not carry a cycle identity.

Completion/skip are written by the operator or skill, optionally via `scripts/loop/checkpoint-contract.mjs`'s `--repo`/`--pr`/`--merge-commit` flags to carry the cycle identity forward.

### On a qualifying completion (written automatically)

```json
{
  "state": "required",
  "triggeredAt": "2026-05-29T16:00:00.000Z",
  "identity": { "repo": "owner/name", "prNumber": 1613, "mergeCommit": "abc123" }
}
```

### After retrospective is done (written by operator or skill)

A minimal completion clears the startup/resume completion gate. The checkpoint
file carries **only completion state** plus the cycle `identity` — retrospective
*findings* (`behavioralReview`, `rawCallViolations`, `internalToolingOnly`) do not
live on disk; they travel in the handoff envelope's `retrospectiveFindings` field
and an advisory PR comment (issue #1077, Reading B):

```json
{
  "state": "complete",
  "completedAt": "2026-05-29T16:30:00.000Z",
  "notes": "Loop followed working agreement; minor drift on thread resolution.",
  "identity": { "repo": "owner/name", "prNumber": 1613, "mergeCommit": "abc123" }
}
```

### Explicit skip with reason

```json
{
  "state": "skipped",
  "skippedAt": "2026-05-29T16:30:00.000Z",
  "reason": "Trivial documentation-only change; no post-run audit needed.",
  "identity": { "repo": "owner/name", "prNumber": 1613, "mergeCommit": "abc123" }
}
```

## Authoritative source locations

| Artifact | Location |
|---|---|
| Checkpoint state machine (identity, cycle scoping) | `packages/core/src/loop/retrospective-checkpoint.mjs` (internal core module; not part of the public package exports surface — its classification/identity helpers are re-exported through `public-dev-loop-routing.mjs` for script-layer callers) |
| Automatic arming seam | `scripts/loop/resolve-dev-loop-startup.mjs` (`buildResolveDevLoopStartupResult`) |
| Manual write CLI (identity-aware) | `scripts/loop/checkpoint-contract.mjs` |
| Internal-tooling verifier (findings-producer) | `scripts/loop/check-retro-tooling.mjs` (+ `test/loop/check-retro-tooling.test.mjs`) |
| Advisory findings envelope field | `packages/core/src/loop/handoff-envelope.mjs` — `retrospectiveFindings` |
| Tests | `packages/core/test/retrospective-checkpoint.test.mjs`, `test/loop/resolve-dev-loop-startup.test.mjs`, `test/loop/checkpoint-contract.test.mjs`, `packages/core/test/pr-gate-coordination.test.mjs`, `packages/core/test/handoff-envelope.test.mjs` |
| Extension (best-effort secondary trigger, writes required marker, fires review prompt) | `.pi/extensions/dev-loop-behavioral-review.ts` |
| Checkpoint file | `.pi/dev-loop-retrospective-checkpoint.json` |
| AGENTS.md repo contract | [Agent Instructions](../../AGENTS.md) — concise repo contract and working rules |
