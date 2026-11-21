### Changed

- A `draft_gate` or `pre_approval_gate` round with no findings no longer dispatches a judge pass; the judge work-order emitter returns a skip result and the gate comment says the judge was skipped (#2926)
