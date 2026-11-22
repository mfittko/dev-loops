### Changed

- The merge wrapper waits up to 540 s for a Gate evidence run. It refuses a failed run (unless `gate-evidence` is `success`), a timeout or a head change with one recovery (#3411)
