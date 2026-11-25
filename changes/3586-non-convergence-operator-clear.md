### Fixed

- The `non_convergence` stop of `write-gate-context.mjs` is now clearable: `--operator-focus-file` takes a decision for each act fingerprint of the latest round, and a retained same-head round that a later round at that head replaced no longer counts in the comparison (#3586).
