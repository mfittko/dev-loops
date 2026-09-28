### Fixed

- The test runner strips inherited run-id markers (DEVLOOPS_RUN_ID, PI_SUBAGENT_RUN_ID) so tests that leak on them fail locally as in CI (#2489)
