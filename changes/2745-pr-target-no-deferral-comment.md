### Fixed

- The gate tools post no deferral comment when the deferral target is the PR itself; a folded finding is recorded by its Details marker, a stamped thread by its thread marker (`issue=<pr>`) plus resolving reply, and a no-stamp thread by its resolving reply plus the ledger entry (#2745)
- A past-window folded medium finding joins the round's deferral record, and folded-filing selection now follows the same visibility rule as the verdict body (#2745)
