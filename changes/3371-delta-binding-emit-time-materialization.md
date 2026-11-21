### Fixed

- The Delta coverage binding authenticates the emitted work order bytes against the emit-time plan hash and the pull receipt hash, so a fix that edits the fixer renderer no longer deadlocks the delta review and the push (#3371)
