### Fixed

- A read-only adapter reports verified terminal execution evidence from an owned Codex journal, so an execution that finished after its worker stopped reports `completed` (#2886)
- Absent, mismatched, malformed or conflicting evidence stays typed `unknown`, never authorizes process probing, and a tool session id never becomes an OS process id (#2886)
