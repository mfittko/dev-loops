### Fixed
- The `copilot-body-disposition` record gains agent-writable `reject=<gate>` and `defer=<gate>` forms bound to the gate judge ledger at the current head, so a judged low or medium Copilot body finding clears without a fix commit, an operator marker or a head bump, also at the Copilot round cap; `merge-pr` `copilot_convergence` accepts them (#2650)
