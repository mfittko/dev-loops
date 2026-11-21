### Changed

- A `draft_gate` or `pre_approval_gate` round with no findings dispatches no judge pass; the judge emitter returns a skip result and the gate comment states the skip (#2926)
