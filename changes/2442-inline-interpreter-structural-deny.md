### Changed

- The inline-interpreter Bash gate denies a closed list of forms, now incl. perl/ruby inline code, in-place edits, outside-temp heredoc writes and write-then-run (#2442)
- The inline-interpreter Bash gate allows quoted, substituted, payload, heredoc-body and incomplete input; `check-retro-tooling` reports `inline-interpreter` (#2442)
- `scanInlineInterpreter` and `inlineInterpreterDenyDetail` are removed from `@dev-loops/core/loop/bash-command-classify`, and `inlineInterpreterVerdict` is added (#2442)
