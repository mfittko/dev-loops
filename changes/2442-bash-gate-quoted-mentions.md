### Fixed

- The Bash gate no longer denies commands whose heredoc bodies or quoted text only mention a wait script, loop keywords or an interpreter name, and its deny reason now names malformed (incomplete) input (#2442)
