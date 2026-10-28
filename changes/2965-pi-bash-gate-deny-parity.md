### Fixed

- The Pi `tool_call` gate enforces the shared Bash-gate deny rules for every role, so a raw `gh pr merge` and a raw PR-body waiver write are blocked on Pi too (#2965)
- Pi also blocks inline interpreters and heredoc-to-node, `git stash`, detached/poll/`&`-backgrounded waits, the `timeout` wrapper and raw `gh pr create` (#2965)
- Pi also blocks raw PR and issue body API writes and ad-hoc sub-issue, review-thread reply and Copilot review-request writes (#2965)
- The coordinator's inline verification is blocked on Pi under `DEVLOOPS_COORDINATOR_READONLY=1`, and a reviewer's quoted read form that spells a gated verb stays allowed (#2965)
- Claude Code now enforces the `timeout N <sanctioned command>` and raw PR/issue body-write denies, which its PreToolUse pre-check never nominated (#2965)
- The shared Bash-gate deny decision refuses a call that omits or mistypes an adapter fact instead of defaulting permissively, and the Pi signature follows the config loader's variant list (#2965)
