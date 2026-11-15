### Changed

- The inline-interpreter Bash gate parses commands with sh-syntax and denies a closed list of forms in every simple command, incl. perl/ruby inline code, in-place edits and heredoc writes (#2442)
- The inline-interpreter Bash gate allows string payloads, quoted heredoc bodies and a pipe into an interpreter; `check-retro-tooling` reports these ceiling cases as `inline-interpreter` (#2442)
- The Claude plugin hook bundle ships sh-syntax under `.claude/hooks/_vendor`, so the Bash gate parses before any `node_modules` exists (#2442)
