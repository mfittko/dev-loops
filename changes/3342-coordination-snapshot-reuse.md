### Changed

- The `loop gate-coordination` pre-flight writes the pull-request coordination context as a snapshot keyed by head SHA, and the gate-context writer and the verdict poster reuse it for the same head within 10 minutes instead of refetching it; the verdict poster re-reads the live head before posting and deletes the snapshot after a successful post (#3342)
