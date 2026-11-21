### Changed

- The gate pre-flight writes one coordination snapshot per PR head; the context writer and verdict poster reuse it for 10 minutes and re-read PR state, body, thread counts and verdicts live (#3342)
