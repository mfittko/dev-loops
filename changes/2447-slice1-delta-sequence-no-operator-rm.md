### Fixed

- A bounded-out delta sequence closes with `gate close-sequence`, so no manual marker delete remains; PR-body act items leave the delta act set (#2447)
- `gate close-sequence --head` accepts a full SHA or a safe marker file name; an unreadable marker closes as `MARKER_UNREADABLE` once old enough with no fixer running (#2447)
- `gate close-sequence` refuses `abandonment_unproven` when the marker's emit plan belongs to another PR (#2447)
- `seal-evidence --kind delta` refuses a malformed or contradicting result with `evidence_malformed` before it seals (#2447)
