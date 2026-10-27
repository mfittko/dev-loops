### Fixed

- A read-only adapter reports verified terminal execution evidence from an owned Codex journal, so an execution that finished after its worker stopped reports `completed` (#2886)
- Absent, mismatched, malformed or conflicting evidence stays typed `unknown`, never authorizes process probing, and a tool session id never becomes an OS process id (#2886)
- A recorded working directory whose `file:` URI carries an encoded path separator is rejected rather than decoded into a real one, so it cannot bind to an expected cwd and clear the cleanup blocker (#2886)
