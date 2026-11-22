### Changed

- The merge wrapper waits up to 540 s for an active Gate evidence run of the head and refuses a failed run or a timeout with the run id and one recovery; `--check` reports it without waiting (#3411)
