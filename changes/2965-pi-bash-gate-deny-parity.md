### Fixed

- The Pi `tool_call` gate enforces the shared Bash-gate deny rules for every role, so a raw `gh pr merge` and a raw PR-body waiver write are blocked on Pi too (#2965)
