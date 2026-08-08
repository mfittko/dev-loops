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

A fresh session can determine the status of the required retrospective by reading `.pi/dev-loop-retrospective-checkpoint.json` and comparing its `identity` (when present) against the latest qualifying completion the caller derives live (see "Cycle scoping" below):

| File state | Mapped checkpoint state | Meaning |
|---|---|---|
| File absent | `RETROSPECTIVE_CHECKPOINT_STATE.NONE` | No qualifying completion has occurred; no requirement |
| `{ "state": "required" }` | `RETROSPECTIVE_CHECKPOINT_STATE.MISSING` | Qualifying completion detected; retrospective pending |
| `{ "state": "complete", "identity": {...} }`, identity matches the latest qualifying completion (or none is known this call) | `RETROSPECTIVE_CHECKPOINT_STATE.COMPLETE` | Retrospective recorded for the current cycle; requirement satisfied |
| `{ "state": "complete", "identity": {...} }`, identity does NOT match the latest qualifying completion | `RETROSPECTIVE_CHECKPOINT_STATE.MISSING` | Stale completion; a newer qualifying cycle has not been discharged |
| `{ "state": "skipped", "identity": {...} }`, identity matches the latest qualifying completion (or none is known this call) | `RETROSPECTIVE_CHECKPOINT_STATE.SKIPPED` | Explicitly skipped with reason for the current cycle; requirement satisfied |
| `{ "state": "skipped", "identity": {...} }`, identity does NOT match the latest qualifying completion | `RETROSPECTIVE_CHECKPOINT_STATE.MISSING` | Stale skip; a newer qualifying cycle has not been discharged |
| File present but malformed (not a JSON object, or an unrecognized `state`) | `RETROSPECTIVE_CHECKPOINT_STATE.MISSING` | Present-but-broken artifact fails closed — never treated as "nothing observed" |

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
`requireRetrospective` is not a one-time gate: a `complete` (or `skipped`) checkpoint MUST be scoped to the exact qualifying completion it discharges, not treated as satisfying every later one forever. The durable artifact carries an `identity` — at minimum `{ repo, prNumber, mergeCommit }` — alongside its `state`.

- **Derivation, at read time, on every evaluation.** There is no write-time "arming" step. `resolve-dev-loop-startup.mjs` queries GitHub directly for the identity of the latest qualifying completion (`resolveLatestQualifyingCompletionIdentity`: the most recently merged PR whose assignees include Copilot — both qualifying gates, `copilot_pr_followup` and `issue_intake`, culminate in such a merge) every time the gate is evaluated, and compares it against the checkpoint's recorded `identity`. Nothing has to remember to write `state: "required"` for the gate to fire correctly, so there is no seam that can be skipped, hit from the wrong working directory, triggered by a read-only preview, or raced.
- **Completion / skip.** Recording `complete` or `skipped` (via `checkpoint-contract.mjs --state <state> --repo <owner/name> --pr <n> --merge-commit <sha>`, alongside `--notes`/`--reason`) MUST carry the cycle `identity` — the full merge commit oid (`gh pr view --json mergeCommit --jq .mergeCommit.oid`), not an abbreviated/short sha — so a later derivation can tell which cycle it discharged. An identity-less `complete`/`skipped` record is trusted only as long as no newer qualifying completion is observed; the moment one is, it fails closed to `MISSING`. `skipped` is scoped exactly like `complete` — an explicit, reasoned escape hatch for one cycle, not a standing exemption.
- **Fail-closed backstop.** The pure resolver (`resolveCheckpointStateFromArtifact` in `packages/core/src/loop/retrospective-checkpoint.mjs`) treats a `complete`/`skipped` checkpoint whose recorded `identity` does not match the latest observed qualifying completion as `MISSING`, not `COMPLETE`/`SKIPPED`. It also treats a present-but-malformed artifact (not a JSON object, or an unrecognized `state`) as `MISSING` — only a genuinely absent file resolves to `NONE`.
- **Fail-closed on query failure.** When `workflow.requireRetrospective` is `true` and the live derivation query itself fails (offline, `gh` error, malformed payload, repo undetectable), the checkpoint state resolves to `MISSING` rather than silently passing through as if no qualifying completion existed.
- **Unaffected repos.** A repo with `workflow.requireRetrospective` unset or `false` never performs the live derivation query — the checkpoint file (if one happens to exist) is still honored, but no extra GitHub call is made and no cycle-scoping comparison against a "latest" identity is possible without one.

## Durable artifact format

`resolve-dev-loop-startup.mjs` never writes this file — it only reads it and derives the comparison live (see "Cycle scoping" above). The file is written by:

- **`.pi/extensions/dev-loop-behavioral-review.ts`** (best-effort, Pi-harness-specific): fires when it observes the standard async `dev-loop` completion message and writes a `required` marker. Its message-based detection does not carry a cycle identity, which is fine — `required` maps to `MISSING` regardless of identity.
- **`scripts/loop/checkpoint-contract.mjs`** (operator/skill-driven): records `complete`/`skipped`/`required`/`none`, carrying the cycle identity via `--repo`/`--pr`/`--merge-commit` when writing `complete` or `skipped` (MUST — see "Cycle scoping" above).

`mergeCommit` MUST be the full commit oid (`gh pr view --json mergeCommit --jq .mergeCommit.oid`), not an abbreviated/short sha — the live derivation always compares against the full oid, so a short sha can never match and the checkpoint would appear permanently stale.

### The `required` marker (written by the extension, best-effort)

```json
{
  "state": "required",
  "triggeredAt": "2026-05-29T16:00:00.000Z"
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
  "identity": { "repo": "owner/name", "prNumber": 1613, "mergeCommit": "3f8a1c9d2b7e4a6f0c5d8e1b3a7f2c9d5e8b1a4c" }
}
```

### Explicit skip with reason

```json
{
  "state": "skipped",
  "skippedAt": "2026-05-29T16:30:00.000Z",
  "reason": "Trivial documentation-only change; no post-run audit needed.",
  "identity": { "repo": "owner/name", "prNumber": 1613, "mergeCommit": "3f8a1c9d2b7e4a6f0c5d8e1b3a7f2c9d5e8b1a4c" }
}
```

## Authoritative source locations

| Artifact | Location |
|---|---|
| Checkpoint state machine (identity, cycle scoping) | `packages/core/src/loop/retrospective-checkpoint.mjs` (internal core module; not part of the public package exports surface — its classification/identity helpers are re-exported through `public-dev-loop-routing.mjs` for script-layer callers) |
| Read-time derivation (queries the latest qualifying completion, compares identity) | `scripts/loop/resolve-dev-loop-startup.mjs` (`buildResolveDevLoopStartupResult`, `resolveLatestQualifyingCompletionIdentity`) |
| Manual write CLI (identity-aware) | `scripts/loop/checkpoint-contract.mjs` |
| Internal-tooling verifier (findings-producer) | `scripts/loop/check-retro-tooling.mjs` (+ `test/loop/check-retro-tooling.test.mjs`) |
| Advisory findings envelope field | `packages/core/src/loop/handoff-envelope.mjs` — `retrospectiveFindings` |
| Tests | `packages/core/test/retrospective-checkpoint.test.mjs`, `test/loop/resolve-dev-loop-startup.test.mjs`, `test/loop/checkpoint-contract.test.mjs`, `packages/core/test/pr-gate-coordination.test.mjs`, `packages/core/test/handoff-envelope.test.mjs` |
| Extension (best-effort secondary trigger, writes required marker, fires review prompt) | `.pi/extensions/dev-loop-behavioral-review.ts` |
| Checkpoint file | `.pi/dev-loop-retrospective-checkpoint.json` |
| AGENTS.md repo contract | [Agent Instructions](../../AGENTS.md) — concise repo contract and working rules |
