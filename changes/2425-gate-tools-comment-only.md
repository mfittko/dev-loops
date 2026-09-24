### Changed

- `judge-pass` and `close-gate-findings` never create an issue; a round's deferred findings go as one comment on the linked spec issue or the PR (#2425)
- The deferral comment targets the PR itself when the PR has no single closing issue or the configured tracker is not GitHub (#2425)
- `close-gate-findings` no longer defer-closes an open thread whose finding the judge disposed `act` (#2425)
- The orchestrator files a new issue from a runner finding only for a blocker; other findings go as comments on existing issues (#2425)
