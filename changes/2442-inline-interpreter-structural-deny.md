### Changed

- The inline-interpreter Bash gate denies only the closed list of forms, now also perl, ruby, sed, awk in-place edits and cat/tee heredoc writes outside a temp path (#2442)
- The inline-interpreter Bash gate allows quoted, substituted, payload, heredoc-body and incomplete input, and `check-retro-tooling` reports these as `inline-interpreter` (#2442)
- `scanInlineInterpreter` and `inlineInterpreterDenyDetail` are removed from `@dev-loops/core/loop/bash-command-classify`, and `inlineInterpreterVerdict` is added (#2442)
