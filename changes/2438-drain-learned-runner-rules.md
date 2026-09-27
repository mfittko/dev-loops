### Fixed

- The spec extractor reads AC, DoD and Non-goals at any heading level, and a spec without AC or DoD names the expected shape (#2438)
- The verdict writer refuses a `fanout_fanin` post without the head's validation artifact and names `run-gate-validation.mjs` (#2438)
- Drain-learned runner rules move into the contracts as `GATE-EXEC-BASE-REFRESH` and six more registered rule IDs (#2438)
- ADR 0096 records the base refresh before every gate round and amends ADR 0066 (#2438)
- The README names the Claude Code permission rules for the verdict post and the ready flip (#2438)
- Dispatch guidance names the linked issue as the spec and cites rules by ID to the roles that need them (#2438)
- The gate `clean` prose and the Copilot request branching match ADR 0089 and the request tool (#2438)
- The follow-up capture rule files a standalone issue only under `MAIN-AGENT-FILING-BLOCKER-ONLY` (#2438)
