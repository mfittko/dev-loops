### Changed

- The merge wrapper waits for an in-flight Gate evidence run of the head before the merge preconditions, and refuses naming the run id and the recovery when the newest run failed or the wait timed out (#3411)
