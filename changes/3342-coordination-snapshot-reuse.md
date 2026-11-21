### Changed

- The `loop gate-coordination` pre-flight writes the pull-request coordination context as a snapshot keyed by head SHA, and the gate-context writer and the verdict poster reuse it for the same head within 10 minutes instead of refetching it; the poster re-reads the head and the verdict comments live, while the other inputs (CI, thread counts, Copilot request state) come from a snapshot younger than 10 minutes taken by the round's pre-flight, and the poster and the draft-state writers delete the snapshot (#3342)
