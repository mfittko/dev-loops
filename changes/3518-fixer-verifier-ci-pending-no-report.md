### Fixed

- The fixer verifier no longer resolves threads at a pushed head whose checks have not registered, and a `ci_pending` refusal publishes no join report, so a rerun after CI settles can (#3518)
