### Fixed

- Unit coordinators hand back only on routes that own a phase, and a phase-only target resumes by phase (#2532)
- A handoff envelope keeps a Windows drive or network-share worktree root, and one root has one `cwd` spelling (#2532)
- A resume identity rejects a non-string branch or phase instead of accepting malformed authoritative state (#2532)
