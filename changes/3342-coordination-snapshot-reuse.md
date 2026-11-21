### Changed

- The gate pre-flight writes one coordination snapshot per PR head; the context writer and verdict poster reuse it for 10 minutes and re-read head, draft state and verdict comments live. (#3342)
