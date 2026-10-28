### Fixed

- The Pi `tool_call` gate enforces the shared Bash-gate deny rules for every role, so a raw `gh pr merge` and a raw PR-body waiver write are blocked on Pi too (#2965)
- Pi also blocks inline interpreters and heredoc-to-node, `git stash`, detached/poll/`&`-backgrounded waits, the `timeout` wrapper and raw `gh pr create` (#2965)
- Pi also blocks raw PR and issue body API writes and ad-hoc sub-issue, review-thread reply and Copilot review-request writes (#2965)
- The coordinator's inline verification is blocked on Pi under `DEVLOOPS_COORDINATOR_READONLY=1`, and the shared deny now runs before a reviewer's read-only allow path (#2965)
