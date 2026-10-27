### Fixed

- Codex terminal execution evidence reconciles from the owned native journal before any process-cleanup escalation, so an execution that finished after its worker stopped reports `completed` (#2886)
- Absent, mismatched, malformed or conflicting evidence stays typed `unknown`, never authorizes process probing, and a tool session id never becomes an OS process id (#2886)
