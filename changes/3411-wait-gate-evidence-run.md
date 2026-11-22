### Changed

- The merge wrapper waits (10 minute wall-clock bound) while any Gate evidence run of the head is queued or in progress, before every other read. A cancelled run never decides. A failed newest non-cancelled run or a timeout refuses with the run id and one exact recovery. `--check` reads the runs once and reports an active or failed run as a `gate_evidence_run` failure (#3411)
