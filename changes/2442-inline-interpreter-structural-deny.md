### Changed

- The inline-interpreter Bash gate denies only the closed list of forms, now also perl and ruby inline code, in-place sed/perl/ruby/awk edits, a cat/tee heredoc write outside a temp path, and running a heredoc-written file in the same command (#2442)
- The inline-interpreter Bash gate allows quoted, substituted, payload, heredoc-body and incomplete input, and `check-retro-tooling` reports these as `inline-interpreter` (#2442)
- `scanInlineInterpreter` and `inlineInterpreterDenyDetail` are removed from `@dev-loops/core/loop/bash-command-classify`, and `inlineInterpreterVerdict` is added (#2442)
