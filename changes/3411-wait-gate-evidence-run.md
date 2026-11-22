### Changed

- The merge wrapper waits up to 540 s for a Gate evidence run and refuses a failed newest non-cancelled run (unless `gate-evidence` is `success`), a timeout or a head change during the wait or the run read with one recovery (#3411)
