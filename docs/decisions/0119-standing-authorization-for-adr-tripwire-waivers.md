# 0119. A standing authorization lets one sanctioned writer waive the ADR tripwire for contract-doc edits

## Status

Accepted — 2026-10-04 ([issue 2463](https://github.com/mfittko/dev-loops/issues/2463))

## Context

Amends [0052](./0052-adr-tripwire-fail-closed.md): the tripwire still blocks the same surfaces and an operator-written waiver stays valid. The way an agent obtains a waiver for a contract-doc edit changes. Record 0052 stays unedited.

The tripwire blocks the ready flip of a PR that touches a decision-shaped surface until the diff adds a `docs/decisions/NNNN-*.md` record or the PR body carries `adr-tripwire:allow <reason>`. The waiver marker is operator-owned, and the harness classifier denies an agent that writes it. Every PR that edits a contract doc stalled at the ready flip until the operator wrote the waiver by hand. Three recent PRs waited between 5 and 7 hours, although each issue's Definition of done required the contract-doc edit that tripped the tripwire.

The stall also pushed agents to raw provider calls: `gh pr edit --body-file` for the waiver, a raw `deleteProjectV2Item` mutation for a mistaken board item, and a script call where `dev-loops gate capture-threads` existed. A skill sentence "never raw `gh pr edit`" did not prevent them. The agent and the operator share one GitHub credential, so comment authorship cannot separate them.

## Decision

- `dev-loops pr edit` routes to the existing `edit-pr.mjs`. `dev-loops queue remove` removes one board item and proves it absent with a direct item lookup.
- No agent hand-writes a waiver line. `edit-pr.mjs` refuses a body whose set of `adr-tripwire:allow` lines differs from the PR's current set, and `create-pr.mjs` refuses any such line. The refusal names `dev-loops pr waive-adr-tripwire`.
- The operator records a standing authorization in `.devloops` under `standingAuthorizations.adrTripwireWaiver` (`grantedBy`, `grantedAt`, `expires` at most 90 days after `grantedAt`, `reason`). The writer reads it only from `origin/<defaultBranch>`. The trust root is that default-branch record plus a deterministic eligibility derivation, not authorship.
- `dev-loops pr waive-adr-tripwire` writes a head-pinned line only when the record is in force, the PR links exactly one tracker issue, every trigger is a `skills/docs/*-contract.md` path named in the issue's AC / DoD matrix, and the current head has a clean `draft_gate` whose recorded `specDigest` equals the issue's current digest. The scope is fixed in code.
- The record never waives an `extension-defaults.yaml` trigger, a rule-modality reversal or removal, an unresolvable scan, or a `standingAuthorizations` change, and it never satisfies or is satisfied by the size-budget, cross-issue, replacement-PR, merge, `copilot-body-disposition` or release approvals.
- The tripwire treats a line whose reason starts with `standing-authorization` as valid only at the `head=` it names and until its `expires=` day (UTC) has passed, and only while every current trigger is a contract-doc listed in its `paths=`, so a later push blocks again until the writer re-runs. A hand-written line keeps today's meaning.
- A diff that changes the `standingAuthorizations` block is a trigger only a decision record satisfies, and `ready-for-review.mjs` and `pre-pr-ready-gate.mjs` refuse its ready flip until the repo owner approves the current head. The policy cannot be widened under a standing merge authorization.
- The Claude Code Bash gate denies `gh pr edit --body`/`--body-file` and a `gh api` write of a `body` field or `--input` payload to `pulls/<n>` or `issues/<n>`, and a `gh api graphql` `updatePullRequest`, as defense in depth. The deny names `pr edit` for PR bodies and `issue edit` for issue bodies. It is a Claude-only seam, and Pi behavior is unchanged.

Rejected: an operator prompt for every contract-doc edit (the stall this record removes). Rejected: a configurable waiver scope or a force flag (a fail-open surface). Rejected: reading the record from the worktree or the PR head (a PR could grant itself the authorization).

## Consequences

A PR whose diff is limited to contract docs that its own issue matrix names reaches the ready flip without an operator prompt, and every other tripwire case still needs an ADR or an operator-written waiver. The operator grants the authorization after merge and bounds it to 90 days. During this PR's own gate the main checkout runs the previous scripts and hooks, which accept the head-pinned line as any non-empty reason, so the change is a hard cut that satisfies its own tripwire with this record.
