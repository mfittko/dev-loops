### Changed

- The merge wrapper waits up to 540 s for a Gate evidence run and refuses a failed newest non-cancelled run (unless `gate-evidence` is `success`), a timeout or a head change (after a wait or a failed-run read) with one recovery (#3411)
