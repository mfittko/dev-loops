### Fixed
- The Bash gate no longer denies heredoc bodies or quoted text that only name an interpreter, and it denies perl, ruby, bun, in-place sed and awk edits and heredoc source writes (#2442)
- The retro tooling check uses the same inline-interpreter matcher as the Bash gate (#2442)
