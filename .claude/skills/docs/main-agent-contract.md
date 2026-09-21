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
`vitest`/`npm test`/`npm run test`/`npm run build` (and the `yarn`/`pnpm` equivalents) inline —
delegate the run to a fresh worker subagent, which reports back a compact pass/fail plus any
failing-test names, or, when checking a pushed commit, prefer CI's structured conclusion
(`gh pr checks` / `scripts/loop/detect-checkpoint-evidence.mjs`) over a local run. Enforced by the
same opt-in `PreToolUse` Bash gate hook and the same `DEVLOOPS_COORDINATOR_READONLY=1` flag; a
worker subagent's verify/build run is unaffected. The draft-gate `gh pr ready`
guard still applies (harness-agnostic). A separate, stricter main-agent read-only boundary can
also be re-imposed via the same hook — opt-in with `DEVLOOPS_MAIN_AGENT_READONLY=1` (default
fail-open) — for repos that want it.

