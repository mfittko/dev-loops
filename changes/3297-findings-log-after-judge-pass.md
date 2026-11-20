### Fixed

- The gate coordinator writes the findings log after `judge-pass` from its `--ledger-out`, and the writer refuses an earlier `fanout_fanin` write while a judge plan has no verdict (#3297)
