### Fixed

- The CI probe reads every page of check runs and commit statuses for a head, so a head with more than 100 check runs no longer reads as `ciStatus: none` (#3280)
