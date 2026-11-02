### Fixed

- Claude Code's Bash hook now denies raw PR/issue body writes for every actor, the operator and main agent included (#3031)
- Claude Code's Bash hook now denies any `timeout N <sanctioned dev-loops command>` wrapper, for every actor (#3031)
