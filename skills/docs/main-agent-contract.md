# Main-agent delegation contract

How dev-loop work is structured depends on the harness.

**Under the Claude Code harness, the dev-loop runs as a single agent that acts as a delegating
COORDINATOR.** The agent invoked for dev-loop work runs git and PR lifecycle operations, runs the
`dev-loops` CLI (including state-changing `gate` / `pr` / `loop` subcommands), and posts gate
verdicts under the operating session's identity. There is no separate read-only "main agent" and
no mandatory async-subagent dispatch: the dev-loop agent owns the work end to end. But for TRACKED
repo files (source, tests, docs) the coordinator is itself read-only, one level down: it MUST
delegate every tracked-file implementation edit to a fresh WORKER subagent
(`developer`/`fixer`/`quality`/`docs`). The coordinator MAY still write EPHEMERAL artifacts
directly — `tmp/`, the scratchpad, and sanctioned ledger paths (the PR body markdown, comment
bodies, dispatch prompts, gate evidence/ledgers under `tmp/gate-findings/`) — because those are
gitignored/non-repo paths, not tracked-file mutations. This coordinator→worker boundary is the
Claude analogue of the absolute main-agent read-only boundary Pi enforces, enforced mechanically
(not by convention) by the same `PreToolUse` Write/Edit guard hook: opt-in via
`DEVLOOPS_COORDINATOR_READONLY=1` (default fail-open), fail-closed once enforced, and
non-bypassable by the coordinator itself — a tracked-file Write/Edit whose `agent_type` is
`dev-loop` is denied; a worker subagent's `agent_type` is unaffected. **The coordinator also
delegates code-verification/build runs** (#2082): it MUST NOT run `bun run verify`/`bun test`/
`vitest`/`npm test`/`npm run test`, and the analogous `build` script across `bun`/`npm`/`yarn`/
`pnpm`, inline — delegate the run to a fresh worker subagent, which reports back a compact
pass/fail plus any failing-test names, or, when checking a pushed commit, prefer CI's structured
conclusion (`gh pr checks` / `scripts/github/detect-checkpoint-evidence.mjs`) over a local run. Enforced by the
same opt-in `PreToolUse` Bash gate hook and the same `DEVLOOPS_COORDINATOR_READONLY=1` flag; a
worker subagent's verify/build run is unaffected. The draft-gate `gh pr ready`
guard still applies (harness-agnostic). A separate, stricter main-agent read-only boundary can
also be re-imposed via the same hook — opt-in with `DEVLOOPS_MAIN_AGENT_READONLY=1` (default
fail-open) — for repos that want it.

<!-- pi-only -->
> **Absolute read-only boundary (Pi).** The main agent must never mutate files tracked by the repository.
> All mutations flow through the `dev-loop` async subagent.

## Contract

The main agent is **read-only** for every file tracked by the repository. Every
write, edit, delete, commit, branch, push, and PR lifecycle operation must flow
through the `dev-loop` async subagent.

This contract is a hard rule, not a default or guideline. The main agent must
never rationalize a direct mutation — not because the work is small, not
because "the user said yes," not because it is running from a worktree.

## Main agent owns (allowed)

- Read, inspect, search any repo file
- `git worktree list`, `git status`, `git log` (read-only git). `git fetch` is also allowed (updates local refs but does not touch tracked working-tree files).
- `gh issue view / create / edit / comment / close` (GitHub API, not file mutations)
- `gh pr view / list` (read-only GitHub API)
- Write to `/tmp` or other non-repo paths (e.g., issue body drafts)
- Delegate to the `dev-loop` agent (async, with worktree cwd)
- Report findings, ask questions, get confirmation
- `bun test`, `bun run verify` (read-only validation under the repository-pinned Bun 1.4.1 toolchain)

## Main agent must NEVER

- `write`, `edit`, or delete any file tracked by the repo
- `git commit`, `git push`, create branches, create worktrees
- Run state-changing dev-loops CLI subcommands (`gate`, any state-changing `loop` subcommand, `pr` commands — those belong inside `dev-loop`).
- Delegate implementation to any agent other than `dev-loop`

## Dev-loop agent (async) owns

- ALL file mutations in the repo (write, edit, delete)
- ALL git operations (branch, commit, push)
- ALL PR lifecycle (create, draft, review, merge)
- Sub-delegation to developer, fixer, review, quality, docs agents. `developer`/`quality`/`docs`/`fixer`
  sub-delegates COMMIT THEIR OWN WORK before exit (`LOCAL-COMMIT-BEFORE-EXIT`); for a session
  that pushes and opens a PR (the scope `local-implementation` SKILL step 11b,
  `LOCAL-PRE-PR-REVIEW-BEFORE-PUSH`, defines: tracker-backed or issue-less `--lightweight`) the
  first push is deferred to that step so the branch reaches origin once, already cleaned — a
  sub-delegate commits but does not push. There is no "edit here, commit there" split: an editing sub-delegate is
  never told not to commit, and a `dev-loop` session that wants a single consolidated commit
  performs the edits itself rather than delegating the edit and keeping the commit. The removed
  `DEVLOOPS_ORCHESTRATOR_OWNS_COMMIT` env-var exemption deadlocked an editing subagent under a
  task-scoped no-commit instruction on the Claude harness (#1936); the
  `subagent-stop-uncommitted-guard` hook stays fully enforced for every editing role.
  See [Delegation contract](../local-implementation/SKILL.md#delegation-contract).

## Model tier at dispatch (Pi)

When dispatching a subagent, resolve its model with
`resolveRoleModel(config, { role, harness: "pi" })` from `@dev-loops/core/config`
(`role` = the subagent/angle name, e.g. `developer`, `refiner`, `review`, or a
gate angle) and pass that model to the async dispatch **only when it is non-null**.
Pass `kind: "angle"` when resolving a **gate fan-out review angle** (a review
activity — e.g. `correctness`, `docs`, `acceptance-criteria`) so it always gets the
review (high) tier even when the angle name collides with a routine role; leave
`kind` unset (or `kind: "role"`) for a routine **subagent role** dispatch. This
matters for `docs`: the `docs` angle must resolve high via `review`, not the `docs`
writer role's low tier.
The built-in policy runs routine subagents (`developer`/`docs`/`fixer`/`quality`)
on the low tier, planning (`refiner`) and critical review (the `review` role, and gate
fan-out review angles via the review tier forced by `kind: "angle"`) on the high tier, and lets the conductor
(`dev-loop`) inherit. Built-in Pi tiers are `null`, so with zero config every role
resolves to `null` and dispatch passes no model override — a genuine no-op on Pi.
Operators opt in by setting concrete Pi ids under `models.tiers.<alias>.pi` (and may
retune `models.roleTiers` / `models.roles`) in `.devloops`. The same resolver drives
the Claude harness, where the tier is baked into each agent's `model:` frontmatter at
asset-generation time (`harness: "claude"`).

## Boundary examples

| Operation | Verdict |
|---|---|
| `gh issue create --title "..." --body "..."` | Allowed — mutates GitHub, not files tracked by the repository |
| Write to `/tmp/issue-body.md` | Allowed — outside the repo |
| Write to `packages/core/src/foo.mjs` | **BREACH** — must delegate to `dev-loop` |
| `git status` | Allowed — read-only |
| `git commit -m "..."` | **BREACH** — must delegate to `dev-loop` |
| `subagent dev-loop` | Allowed — correct delegation |
| `subagent fixer` | Allowed only when called from within `dev-loop`; describe the task as part of the message |
| Claude Code: the `dev-loop` coordinator writes `packages/core/src/foo.mjs` directly | **BREACH** — must delegate to a fresh worker subagent (`developer`/`fixer`/`quality`/`docs`) |
| Claude Code: the `dev-loop` coordinator writes `tmp/gate-findings/...` (gate evidence) | Allowed — ephemeral/gitignored, not a tracked-file mutation |
| Claude Code: the `dev-loop` coordinator runs `bun run verify` inline | **BREACH** when `DEVLOOPS_COORDINATOR_READONLY=1` is enforced — delegate the run to a fresh worker subagent |
| Claude Code: a worker subagent (`developer`/`fixer`/`quality`/`review`) runs `bun run verify` | Allowed — verification runs are the worker's job |

## Dev-loop startup

When a user triggers the dev loop, the main agent must immediately dispatch the
`dev-loop` async subagent. The subagent owns the startup resolver, route selection,
and all subsequent implementation steps. The main agent never runs `dev-loops loop startup`
directly.

## Async dispatch posture (Pi)

When the main agent dispatches the `dev-loop` async subagent in an interactive session, it MUST
return control to the user after dispatch and MUST NOT call `subagent_wait` to block on
completion. Pi wakes the session when the async run completes or needs-attention.

The only exception is **run-to-completion**: the user explicitly asked for results reported back
before continuing, or a skill must finish within a single turn. In that case the main agent may
wait for the subagent's result before returning control.

Calling `subagent_wait` merely to wait out an async dispatch freezes the interactive session for
the full run duration (often 30+ minutes per dev-loop drive) and defeats async dispatch. The Pi
platform default already says return control; do not call `subagent_wait` merely to wait. This
clause reinforces that for the `dev-loop` dispatch pattern specifically.

## Enforcement posture

- Under **Pi**, this contract is enforced by convention and review.
- Under **Claude Code**, the **Edit/Write tool** path is enforced **mechanically** by a
  `PreToolUse` Write/Edit hook (`.claude/hooks/pre-tool-use-write-guard.mjs`, wired via
  `.claude/settings.json` for this repo's own sessions and via `.claude/hooks/hooks.json` for the
  Claude plugin): a Write/Edit whose target is inside the repo working tree and not
  gitignored is **denied** when it originates from the main agent, and allowed only inside the
  `dev-loop` subagent context (detected via the neutral `DEVLOOPS_RUN_ID` run-id contract, or
  the dev-loop `agent_type` — a generic subagent is not authorized).
  Strict enforcement is opt-in via `DEVLOOPS_MAIN_AGENT_READONLY=1` (default fail-open) so
  adopting the harness does not retroactively break a repo's own interactive dev; full run-id
  propagation into the Claude subagent context completes with the headless/agent wiring.
- **Coordinator→worker delegation boundary (#2082).** The same Write/Edit guard hook also
  enforces a second, inner boundary under Claude Code: a tracked-file Write/Edit whose
  `agent_type` is the coordinator's own (`dev-loop`) is denied — the coordinator must delegate
  the edit to a fresh worker subagent (`developer`/`fixer`/`quality`/`docs`) instead. Opt-in via
  `DEVLOOPS_COORDINATOR_READONLY=1` (default fail-open); fail-closed once enforced and
  non-bypassable by the coordinator. Ephemeral artifacts (`tmp/`, the scratchpad, sanctioned
  ledger paths) are gitignored/non-repo paths, so they fall through unaffected.
- **Coordinator verify-command delegation boundary (#2082).**
  <!-- rule: COORDINATOR-VERIFY-DELEGATION -->
  `COORDINATOR-VERIFY-DELEGATION`: the dev-loop coordinator MUST NOT run a known
  code-verification/build entrypoint (`bun run verify`/`bun test`/`vitest`/`npm test`/
  `npm run test`, and the analogous `build` script across `bun`/`npm`/`yarn`/`pnpm`) inline; it
  MUST delegate the run to a fresh worker subagent (`developer`/`fixer`/`quality`/`review`) instead. Enforced by the
  `PreToolUse` Bash gate hook (`.claude/hooks/pre-tool-use-bash-gate.mjs`), which denies the
  command when the caller's `agent_type` is the coordinator's own (`dev-loop`). Gated by the SAME
  `DEVLOOPS_COORDINATOR_READONLY=1` flag as the write-guard boundary above (default fail-open); a
  worker subagent's `agent_type` is unaffected.
- **Scope of mechanical enforcement:** the hook covers the Edit and Write tools. Bash-driven
  repo mutations the contract also forbids (`git commit`/`git push`/branch creation, in-place
  edits like `sed -i`, shell redirection `> file` / `tee`) run through the Bash tool and remain
  **convention-enforced** for now; the only Bash command the gate hook blocks is the ungated
  `gh pr ready`. Tightening Bash-mutation coverage is possible follow-up.
- A companion `PreToolUse` Bash hook reproduces the `gh pr ready` draft-gate guard.
- A `dev-loop` async subagent should still reject delegation attempts that bypass the contract.

## Non-goals

- Pre-commit hooks (out of scope; the boundary is enforced at the Claude tool layer).
- Changing dev-loop resolver behavior
- Modifying the subagent API itself
<!-- /pi-only -->
