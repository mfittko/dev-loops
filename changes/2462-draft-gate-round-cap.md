### Added

- `draft_gate` stops after `gates.draft.maxReviewRounds` rounds (default 4, `0` disables): a new act item blocks as `round_cap_reached`, a judge defer or reject is recorded as `capClosed` (#2462)
