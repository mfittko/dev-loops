### Fixed

- The fixer verifier no longer resolves threads at a pushed head with unregistered checks, and a `ci_pending` refusal publishes no join report, so a rerun after CI settles does (#3518)
