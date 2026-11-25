### Added

- `gates.preApproval.maxReviewRounds` caps `pre_approval_gate` rounds and a scoped final round follows the cap, within `gates.capFixMaxLines` (#3357)
- A `blocked` gate verdict names its causes in a `Blocked by` line, and a block without findings asks for an operator step instead of a fix round (#3357)
