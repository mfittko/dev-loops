### Fixed

- Fixer construction removes its own marker after a failed publish, so a retry succeeds; a foreign or replaced marker is never removed (#2880)
