### Changed

- The merge wrapper waits up to 540 s for an active Gate evidence run of the head and refuses a failed run (unless the `gate-evidence` status is `success`), a timeout or a head change with the run id and one recovery, the same text in the reason and in `recovery`; `--check` reports it without waiting (#3411)
