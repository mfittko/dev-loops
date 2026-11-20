### Fixed

- The gate findings-log writer refuses a `fanout_fanin` write without `--judge-verdict` while the round has a judge plan with no verdict yet, and the gate coordinator writes the log after `judge-pass` from its `--ledger-out` (#3297)
