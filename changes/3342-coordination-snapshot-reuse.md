### Changed

- The gate pre-flight writes one coordination snapshot per PR head; the context writer and verdict poster reuse it for 10 minutes; the verdict poster re-reads PR state, body, linked issues, thread counts and verdicts live (#3342)
