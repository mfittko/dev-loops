### Fixed

- A bounded-out delta sequence closes with `gate close-sequence`, so no manual marker delete remains; PR-body act items leave the delta act set (#2447)
- `gate close-sequence --head` accepts a full SHA or a safe marker file name (`^[A-Za-z0-9._][A-Za-z0-9._-]{0,127}$`, never `.` or `..`); a marker that is unreadable, names no branch or sits under a non-hex name closes as `MARKER_UNREADABLE` once it is as old as the dispatch grace and no fixer runs, and the close refuses `abandonment_unproven` when the marker's emit plan belongs to another PR (#2447)
- `seal-evidence --kind delta` refuses a malformed or contradicting result with `evidence_malformed` before it seals (#2447)
