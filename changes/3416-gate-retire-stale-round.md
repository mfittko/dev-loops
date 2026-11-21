### Fixed

- Rebuilding the gate context or re-emitting the fan-out at the same head retires the stale undispatched round, and a blocked reviewer no longer overwrites a finished artifact (#3416)
