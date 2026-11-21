### Fixed

- Rebuilding the gate context or re-emitting the fan-out at the same head retires the stale undispatched or finished round and refuses while a reviewer is still running, and a blocked reviewer no longer overwrites a finished artifact (#3416)
