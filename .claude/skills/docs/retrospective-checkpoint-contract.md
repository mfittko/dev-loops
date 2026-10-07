# Retrospective checkpoint contract

Canonical owner for the enforcement seam of the post-run behavioral retrospective checkpoint after qualifying async `dev-loop` completions in this repository.

## Fresh-context neutral retrospective (issue #1870)

<!-- rule: RETRO-FRESH-CONTEXT-MANDATORY -->
A qualifying retrospective MUST be produced by a **fresh-context, independent dispatch** — analogous to a gate reviewer — seeded with the cycle's **full agent/subagent tool-call/action/result record** (the existing session transcript/journal artifacts; no new transcript store). The retro evaluates neutrally against the contracts and the issue's acceptance criteria / definition of done / non-goals and produces its finding independently of the implementing agent's self-view.

An **inline, self-authored retrospective**, written by the working/session context that did the work, is **disallowed and fails the checkpoint**, because it cannot see a systematic error that context committed.

The CLI enforces point 2 and the read side enforces point 3. Point 1 is agent discipline (`LOCAL-RETRO-FRESH-CONTEXT-DISPATCH`, `enforcement: "agent"`): provenance is self-attested at write time, so the durable guarantee is that no inline/legacy record passes the checkpoint, not that the attestation is verifiable.

1. the retro pass is dispatched as a fresh-context subagent (no inherited working/session context or self-narrative) with the record path as its primary input;
2. the checkpoint CLI (`checkpoint-contract.mjs --state complete`) requires `--retro-context fresh` (an `inline` value is rejected outright) and `--record-source <path>` naming the record the retro was seeded with; `--record-source` MUST resolve (from the invocation cwd; absolute paths allowed) to an existing, non-empty file, so a retro attested against a record that does not exist is rejected at write time;
3. the durable artifact carries that provenance, and the pure resolver (`resolveCheckpointStateFromArtifact`) treats a `complete` record whose `provenance` does not pin a fresh-context pass over the record as `MISSING` — fail-closed, including every legacy inline retro.

Provenance shape:

```json
{ "context": "fresh", "seededFrom": "agent_tool_call_record", "recordSource": "<path to transcript/journal artifact>" }
```

`skipped` records are not provenance-gated: no retro ran, so there is nothing to have provenance.

<!-- rule: RETRO-ENFORCEMENT-CONFIG-GATED -->
Whether the checkpoint is evaluated MUST be controlled by `.devloops` at repo root `workflow.requireRetrospective`; shipped defaults remain permissive and this repo opts in. With the flag unset or `false`, startup reports no `pendingRetrospectives`, `merge-pr` does not evaluate `retrospective_checkpoint`, and neither site reads the checkpoint file or runs the ancestry lookup.

## Relationship to formal dev mode

Formal local dev mode and the required post-run behavioral retrospective are related but distinct:

| Requirement | Scope |
|---|---|
| **Formal local dev mode** | Local implementation/self-improvement work; explicitly scoped in [Dev Loop Skill](../dev-loop/SKILL.md) |
| **Required post-run behavioral retrospective** | Every qualifying async GitHub-first `dev-loop` completion in this repo |

Routed GitHub-first async `dev-loop` runs do **not** need to be in full formal local dev mode. When `workflow.requireRetrospective` is enabled, they **do** require the retrospective checkpoint to be discharged before the next merge. A pending retrospective does not block start or resume (ADR 0125).

## Qualifying completions

A qualifying async `dev-loop` completion is one that:
- routes through a GitHub-first Copilot-owned strategy gate, and
- has `routeKind === "route"` (inspect/status-only results do not qualify).

Qualifying gates:

| Gate | Strategy | Description |
|---|---|---|
| `copilot_pr_followup` | Copilot PR follow-up | Primary routed GitHub-first async path |
| `issue_intake` | Issue intake | Copilot-first issue assignment path |

`RETROSPECTIVE_QUALIFYING_GATES` in `packages/core/src/loop/retrospective-checkpoint.mjs` enumerates these descriptively; no runtime consumer consults it. The practical arming trigger is the message-shape match in `.pi/extensions/dev-loop-behavioral-review.ts` (below).

## Checkpoint states

A fresh session determines the status of the required retrospective by reading `.pi/dev-loop-retrospective-checkpoint.json` and, for a `complete`/`skipped` record, checking whether a newer PR has merged into the configured base branch since the recorded discharge point (see [Cycle scoping](#cycle-scoping--a-checkpoint-discharges-exactly-one-qualifying-completion) below):

| File state | Mapped checkpoint state | Meaning |
|---|---|---|
| File absent (ENOENT) | `RETROSPECTIVE_CHECKPOINT_STATE.NONE` | No checkpoint requirement recorded in this repo's shared main-root file |
| `{ "state": "none" }` | `RETROSPECTIVE_CHECKPOINT_STATE.NONE` | Explicitly recorded as no requirement |
| `{ "state": "required" }` or `{ "state": "missing" }` | `RETROSPECTIVE_CHECKPOINT_STATE.MISSING` | Retrospective pending; reported as `pendingRetrospectives` and refused at merge by `merge-pr` |
| `{ "state": "complete", "identity": {...}, "provenance": {...} }`, no newer PR has merged into the configured base | `RETROSPECTIVE_CHECKPOINT_STATE.COMPLETE` | Retrospective recorded for the current cycle as a fresh-context pass over the tool-call record; requirement satisfied |
| `{ "state": "complete", "identity": {...} }` with no/invalid/inline `provenance`, no newer PR merged into the configured base | `RETROSPECTIVE_CHECKPOINT_STATE.MISSING` | Inline or unverifiable retro — fails closed (see [RETRO-FRESH-CONTEXT-MANDATORY](#fresh-context-neutral-retrospective-issue-1870)); re-discharge with `--retro-context fresh --record-source <path>` |
| `{ "state": "complete", "identity": {...} }`, a newer PR merged into the configured base (or ancestry/association cannot be verified) | `RETROSPECTIVE_CHECKPOINT_STATE.MISSING` | Stale completion; a newer cycle has not been discharged |
| `{ "state": "complete" }` or `{ "state": "skipped" }` with no `identity` | `RETROSPECTIVE_CHECKPOINT_STATE.MISSING` | Legacy identity-less record — the shape every pre-cycle-scoping checkpoint has. It cannot be verified against any cycle, so it fails closed without running the ancestry check; discharge it by re-recording with the identity flags |
| `{ "state": "skipped", "identity": {...} }`, no newer PR has merged into the configured base | `RETROSPECTIVE_CHECKPOINT_STATE.SKIPPED` | Explicitly skipped with reason for the current cycle; requirement satisfied |
| `{ "state": "skipped", "identity": {...} }`, a newer PR merged into the configured base (or ancestry/association cannot be verified) | `RETROSPECTIVE_CHECKPOINT_STATE.MISSING` | Stale skip; a newer cycle has not been discharged |
| The JSON literal `null`, any other non-object value (e.g. a scalar or array), or an unrecognized `state` string | `RETROSPECTIVE_CHECKPOINT_STATE.MISSING` | Present-but-broken artifact fails closed — never treated as "nothing observed" |

<!-- rule: RETRO-ABSENT-NEVER-BLOCKS -->
An **absent** checkpoint file or an explicit `{ "state": "none" }` resolves to `NONE`, not `MISSING`. A present malformed artifact fails closed. The gitignored file is shared by every linked worktree through `RETRO-CHECKPOINT-REPO-ROOT`; a fresh clone may have no file, but creating a worktree does not reset the checkpoint. Recency only re-evaluates an existing `complete`/`skipped` record: it cannot arm an absent or explicit-none checkpoint. An explicit `required`/`missing` write or an invalid/stale discharge record produces `MISSING`.

## Enforcement gate

The enforcement seam is the pure function `evaluateRetrospectiveGate` in `packages/core/src/loop/retrospective-checkpoint.mjs`. The checkpoint artifact may still exist even when enforcement is disabled; callers must first consult `workflow.requireRetrospective` to decide whether the checkpoint is evaluated at all. A `missing` state never blocks routed start/resume; `merge-pr` enforces it at merge time.

The public routing helpers in `packages/core/src/loop/public-dev-loop-routing.mjs` also accept an optional `retrospectiveCheckpointState` input and apply the same gate internally before returning routed start/resume/status results. Callers should only pass that input when `workflow.requireRetrospective` is enabled for the active repo/workflow posture.

### Inputs

```js
evaluateRetrospectiveGate({
  checkpointState,  // one of RETROSPECTIVE_CHECKPOINT_STATE
  proposedRouting,  // result from evaluatePublicDevLoopRouting()
})
```

### Outputs

- **Pass-through** (proposed routing returned unchanged) when:
  - `checkpointState` is `none`, `complete`, `skipped`, or `missing` (a `missing` state routes normally; the obligation is reported as `pendingRetrospectives` and enforced at merge by `merge-pr`, ADR 0125)
  - `proposedRouting` is already `stop`, `needs_reconcile`, or `inspect`
- **Fail-closed** (`needs_reconcile` result) when:
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
4. Use the returned result directly. A missing checkpoint does not change the routing; report it as `pendingRetrospectives` (see [Pending retrospectives and the merge precondition](#pending-retrospectives-and-the-merge-precondition)).

#### Option B — explicit manual gate composition

1. Read `.pi/dev-loop-retrospective-checkpoint.json` (if it exists).
2. Map the file contents to a `RETROSPECTIVE_CHECKPOINT_STATE` value.
3. Call `evaluatePublicDevLoopRouting(...)` to get the proposed routing.
4. Call `evaluateRetrospectiveGate({ checkpointState, proposedRouting })`.
5. Use the gate result as the effective routing decision. A `missing` state passes through unchanged and an unrecognized state returns `needs_reconcile`.

<!-- rule: RETRO-GATE-FAIL-CLOSED -->
If the gate result is `needs_reconcile` (an unrecognized checkpoint state or an invalid routing input), the caller MUST NOT proceed with the proposed routing. A `missing` checkpoint does not stop startup. It is enforced fail-closed at merge: `merge-pr` refuses while an earlier qualifying merge has no `complete` or `skipped` checkpoint (ADR 0125).

### Pending retrospectives and the merge precondition

One shared evaluator, `resolvePendingRetrospectives` in `scripts/loop/resolve-dev-loop-startup.mjs`, reads the checkpoint through `RETRO-CHECKPOINT-REPO-ROOT`, runs the repo-identity check and the qualifying-merge rule, and maps the record to a state. Startup and `merge-pr` both call it. It returns `{ checkpointState, recordedState, pendingRetrospectives }`; `recordedState` is the state the file records, or null.

- Each `pendingRetrospectives` entry is `{ pr, mergeCommit }`. A `required` or `missing` record with an identity for this repo names that identity. A stale `complete` or `skipped` record names the first qualifying newer merge.
- An entry whose merge cannot be identified has `pr: null`, `mergeCommit: null` and a `reason` code: `checkpoint_unreadable`, `checkpoint_malformed`, `checkpoint_identity_missing`, `checkpoint_foreign_repo` (any record naming another repo), `association_number_invalid`, `ancestry_or_association_unverifiable`, or `newer_merge_unidentified`.
- A `none`, `complete` or `skipped` state yields `pendingRetrospectives: []`.
- Startup routes the unit normally and carries `pendingRetrospectives` in the bundle. The orchestrator dispatches each reported retrospective in parallel with the unit.
- `merge-pr` fails the `retrospective_checkpoint` precondition when the list is not empty. The refusal names the PR number and full merge commit of each entry, or the reason code and the recorded checkpoint state (`recordedState`) for an entry with no identity. The PR being merged is not merged yet, so the rule never counts it.

### Recording a discharge

When a retrospective has run, record it with the `complete` command under [Cycle scoping](#cycle-scoping--a-checkpoint-discharges-exactly-one-qualifying-completion). When the obligation for a cycle is discharged without a retrospective pass, record that fact with factual wording:

```sh
node scripts/loop/checkpoint-contract.mjs --state skipped \
  --reason "Retrospective obligation for PR <number> discharged without a pass: <factual reason>" \
  --repo <owner/name> --pr <number> --merge-commit <full merge commit oid>
```

The record names one cycle and is not a standing exemption. The command needs no standing-authorization key.

## Advisory findings — never a merge gate (issue #1077, Reading B)

<!-- rule: RETRO-ADVISORY-NEVER-GATE -->
The retrospective is **advisory**: it runs, records flagged raw-call / discipline
observations honestly, and passes them back to the conductor (main agent) to
**decide** what to do with them — but it MUST NOT block a merge or any PR-lifecycle
transition of the current run on account of its findings. The only blocking input is the
completion state of an earlier merge's checkpoint (`retrospective_checkpoint` in
`merge-pr`, ADR 0125, which amends ADR 0024). The pre-merge retrospective gate (`evaluateRetrospectiveMergeApproval`
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
   comment carrying the same findings from step 1. Durable and on-GitHub, but **not a
   gate**. No disk artifact is written for retrospective *findings* — they stay
   distinct from the persisted checkpoint state record (see [After retrospective is
   done](#after-retrospective-is-done-written-by-operator-or-skill)).
3. **No config.** The retrospective always runs and always returns findings.

An otherwise green PR becomes merge-ready with the violations **recorded**, not blocked.

### Internal-tooling-only rule (issue #982) — now advisory

The loop's own execution should use internal dev-loops tooling, not agent-level raw
`gh`/`python`/`node -e` escape hatches. **It no longer blocks.** The flagged calls
are reported as advisory findings via the envelope + PR comment.

**Flagged as raw-call violations:** `gh ...` (including `gh api`, `gh ... --jq`),
`python` / `python3`, `node -e` / `node --eval` (inline eval). **Allowed (NOT
violations):** dev-loops subcommands and `node scripts/*.mjs` invocations — those
scripts legitimately call `gh`/GraphQL internally; that is the tooling. The rule
targets the agent's own top-level shell calls, not a script's internals.

**Write-op allowlist (verifier only):** the verifier still records raw `gh pr ready`
as an `allowedWriteOp`. This legacy classification does not authorize it:
`RAW-GH-PR-READY-BYPASS` in [Anti-patterns](anti-patterns.md) requires the existing
`ready-for-review.mjs` wrapper. Ops with a sanctioned wrapper, `gh pr merge`
(`scripts/github/merge-pr.mjs`, issue #1939), `gh issue create`
(`scripts/github/create-issue.mjs`), `gh issue edit` (`scripts/github/edit-issue.mjs`) and
`gh label create` (`scripts/github/create-label.mjs`), are NOT allowlisted, so a raw
agent-level call is flagged. None of these findings block anything.

**Inline-interpreter check item:** the raw-call scan below records
`node -e`/`python3 -c`/heredoc calls, the class barred by `OPS-NO-INLINE-INTERPRETER` in
[Copilot loop operations](copilot-loop-operations.md), as `rawCallViolations` entries under
`RETRO-ADVISORY-NEVER-GATE`.

### Deterministic verifier (findings-producer)

`node scripts/loop/check-retro-tooling.mjs [--transcript <path>] [--json]` reads a
newline-delimited transcript of the shell commands the agent ran (one top-level
command per line, via `--transcript` or stdin) and reports agent-level raw
`gh`/`python`/`python3`/`node -e`/`node --eval` calls. It is a **findings-producer**:
its JSON output (`{ ok, internalToolingOnly, rawCallViolations, allowedWriteOps }`)
is returned to the conductor via the envelope's `retrospectiveFindings` field (normalized
to `{ internalToolingOnly, rawCallViolations, allowedWriteOps }`). It is **not** written to a
checkpoint and **not** a gate. Exit code `1` when violations
are found, `0` when clean, `2` for unreadable input (a stdin or `--transcript` file read error) or empty input
(`empty transcript`), which never reports clean. The pure `analyzeTranscript(transcript)` export returns
`{ violations, allowedWriteOps, internalToolingOnly }`.

Matching rules: a tool name at the start of a command segment (start of line, or after
`&&`/`||`/`|`/`;`), after the verifier strips `NAME=value` prefixes, a leading wrapper binary
from `{sudo, env, xargs, time, nice, command}`, and a path prefix; `node` is a violation only
with `-e`/`--eval`. It does NOT fully parse shell quoting or substitution, so prefer
single-line, single-purpose commands in transcripts.

## Cycle scoping — a checkpoint discharges exactly one qualifying completion

<!-- rule: RETRO-CHECKPOINT-CYCLE-SCOPED -->
`requireRetrospective` is not a one-time gate: a `complete` (or `skipped`) checkpoint MUST be scoped to the exact qualifying completion it discharges, not treated as satisfying every later one forever. The durable artifact carries an `identity` — at minimum `{ repo, prNumber, mergeCommit }` — alongside its `state`.

- **The question is PR-merge recency.** Has a newer PR merged into the configured base branch since the checkpoint's recorded discharge point? Direct commits, release commits, tags, open or closed-unmerged PRs, and PRs merged into another base do not open a retrospective cycle.
- **Derivation, at read time, on every evaluation of a discharge record.** Recency needs no write-time re-arming of an existing `complete`/`skipped` record; the extension's independent best-effort `required` writer remains supported. Before inspecting ancestry, the checkpoint identity's `repo` MUST exactly match the current repository auto-detected from the checkout whose base history will be inspected; a foreign or unresolvable repository identity fails closed. `resolveHasNewerMergeSinceCheckpoint` (`scripts/loop/resolve-dev-loop-startup.mjs`) runs a best-effort `git fetch origin <baseBranch>`, uses `git rev-list <mergeCommit>..origin/<baseBranch>` to bound candidate commits, and queries the GraphQL `Commit.associatedPullRequests` connection as merge authority. A candidate qualifies only when GraphQL reports a `MERGED` PR whose merge commit is that candidate and whose base ref equals the configured base. This covers non-default configured bases and one-parent squash merges.
- **Unverifiable ancestry or association fails closed.** When the checkpoint commit cannot be resolved against `origin/<baseBranch>`, or a required GitHub association lookup fails or returns malformed facts, the check resolves to `MISSING`. The GraphQL authority query MUST validate `pageInfo`, follow cursors, and stop at its fixed page bound; malformed responses, missing cursors, and exhausted pagination all fail closed.
- **Completion / skip.** Recording `complete` or `skipped` (via `checkpoint-contract.mjs --state <state> --repo <owner/name> --pr <n> --merge-commit <sha>`, alongside `--notes`/`--reason`) MUST carry the cycle `identity`; the CLI rejects `complete`/`skipped` with no identity. A `complete` record additionally MUST carry the fresh-context provenance via `--retro-context fresh --record-source <path>` (the CLI rejects `inline` outright and rejects `complete` with no provenance flags). `--merge-commit` MUST be the full 40-hex merge commit oid (`node scripts/github/view-pr.mjs --repo <owner/name> --pr <n> --json mergeCommit --jq .pr.mergeCommit.oid`); the CLI rejects a short sha. `--repo` MUST be `owner/name` shape. `skipped` is scoped exactly like `complete`: an explicit, reasoned escape hatch for one cycle, not a standing exemption.
- **Fail-closed backstop.** The pure resolver (`resolveCheckpointStateFromArtifact` in `packages/core/src/loop/retrospective-checkpoint.mjs`) takes the caller-derived ancestry result as a boolean (`hasNewerMergeSinceCheckpoint`) and treats a `complete`/`skipped` checkpoint as `MISSING` whenever it is set. It also treats a present-but-malformed artifact as `MISSING` (see [Checkpoint states](#checkpoint-states) and `RETRO-ABSENT-NEVER-BLOCKS`).
- **Unaffected repos.** A repo with `workflow.requireRetrospective` unset or `false` never reads or applies the checkpoint file and never runs the ancestry fetch or log. Repo-root path resolution still runs one local `git worktree list` on every resolve.

### Checkpoint path resolves from the repo root, not cwd

<!-- rule: RETRO-CHECKPOINT-REPO-ROOT -->
`.pi/dev-loop-retrospective-checkpoint.json` is gitignored and lives **once per repo**, not once per worktree. Both the read path (`resolve-dev-loop-startup.mjs`) and the write path (`checkpoint-contract.mjs`) resolve the checkpoint's directory through `resolveCheckpointRepoRoot(cwd)`: the first line of `git worktree list` (always the main worktree), parsed by `parseMainWorktreePath`. It falls back to `cwd`, never throwing, only when `git worktree list` cannot be resolved at all. The best-effort `required`-marker write in `.pi/extensions/dev-loop-behavioral-review.ts` uses a vendored copy of the same logic.

## Durable artifact format

`resolve-dev-loop-startup.mjs` only reads this file. The file is written by:

- **`.pi/extensions/dev-loop-behavioral-review.ts`** (best-effort, Pi-harness-specific): fires when it observes the standard async `dev-loop` completion message and writes a `required` marker without a cycle identity; `required` maps to `MISSING` regardless of identity.
- **`scripts/loop/checkpoint-contract.mjs`** (operator/skill-driven): records `complete`/`skipped`/`required`/`missing`/`none`, carrying the cycle identity via `--repo`/`--pr`/`--merge-commit` — MUST for `complete`/`skipped` (see [Cycle scoping](#cycle-scoping--a-checkpoint-discharges-exactly-one-qualifying-completion) above), optional for `required`/`missing`, rejected for `none`.

### The `required` marker (written by the extension, best-effort)

```json
{
  "state": "required",
  "triggeredAt": "2026-05-29T16:00:00.000Z"
}
```

`{ "state": "missing" }` is accepted identically to `{ "state": "required" }`.

### After retrospective is done (written by operator or skill)

The checkpoint file carries **completion state**, the cycle `identity`, and the **fresh-context
provenance** (issue #1870). Retrospective *findings* (`behavioralReview`, `rawCallViolations`,
`internalToolingOnly`) never live on disk; they travel as described in
[How findings travel](#how-findings-travel-reading-b).

```json
{
  "state": "complete",
  "completedAt": "2026-05-29T16:30:00.000Z",
  "notes": "Loop followed working agreement; minor drift on thread resolution.",
  "identity": { "repo": "owner/name", "prNumber": 1613, "mergeCommit": "3f8a1c9d2b7e4a6f0c5d8e1b3a7f2c9d5e8b1a4c" },
  "provenance": { "context": "fresh", "seededFrom": "agent_tool_call_record", "recordSource": "tmp/retrospectives/pr-1613/record.jsonl" }
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

`{ "state": "none" }` records "no requirement" explicitly and resolves like an absent file.

## Authoritative source locations

| Artifact | Location |
|---|---|
| Checkpoint state machine (identity normalization, ancestry-scoped state resolution) | `packages/core/src/loop/retrospective-checkpoint.mjs` (internal core module; `normalizeCheckpointCycleIdentity`/`resolveCheckpointStateFromArtifact` are re-exported through `public-dev-loop-routing.mjs` for script-layer callers) |
| Read-time derivation (ancestry check, repo-root path resolution) | `scripts/loop/resolve-dev-loop-startup.mjs` (`buildResolveDevLoopStartupResult`, `resolvePendingRetrospectives`, `resolveHasNewerMergeSinceCheckpoint`; also called by `scripts/github/merge-pr.mjs`) |
| Manual write CLI | `scripts/loop/checkpoint-contract.mjs` (`resolveCheckpointRepoRoot`) |
| Internal-tooling verifier (findings-producer) | `scripts/loop/check-retro-tooling.mjs` |
| Advisory findings envelope field | `packages/core/src/loop/handoff-envelope.mjs` — `retrospectiveFindings` |
| Extension (best-effort secondary trigger, writes required marker, fires review prompt) | `.pi/extensions/dev-loop-behavioral-review.ts` |
| Checkpoint file | `.pi/dev-loop-retrospective-checkpoint.json` |
