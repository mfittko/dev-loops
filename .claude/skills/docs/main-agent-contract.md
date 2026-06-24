# Main-agent delegation contract

How dev-loop work is structured depends on the harness.

**Under the Claude Code harness, the dev-loop runs as a single agent.** The agent invoked for
dev-loop work performs the steps directly — it reads and writes repository files, runs git and PR
lifecycle operations, runs the `dev-loops` CLI (including state-changing `gate` / `pr` / `loop`
subcommands), and posts gate verdicts under the operating session's identity. There is no separate
read-only "main agent" and no mandatory async-subagent dispatch: the dev-loop agent owns the work
end to end. The draft-gate `gh pr ready` guard still applies (harness-agnostic). A read-only
boundary can be re-imposed optionally via the Write/Edit guard hook — opt-in with
`DEVLOOPS_MAIN_AGENT_READONLY=1` (default fail-open) — for repos that want it.

