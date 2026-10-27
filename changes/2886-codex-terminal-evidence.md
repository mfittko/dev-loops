### Fixed

- Codex terminal execution evidence is reconciled from the owned native journal before any process-cleanup escalation: an execution that reached a terminal result after its worker stopped reports `completed` with the recorded timestamp, exit status, exit code, command and working directory, while absent, mismatched, malformed or conflicting evidence stays typed `unknown` and never authorizes process probing (#2886)
