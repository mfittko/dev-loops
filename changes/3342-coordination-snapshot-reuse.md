### Changed

- The gate pre-flight writes one coordination snapshot per PR head; the context writer and verdict poster reuse it, and the poster re-reads PR state live (#3342)
