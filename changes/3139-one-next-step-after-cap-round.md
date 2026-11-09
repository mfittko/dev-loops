### Fixed
- After the draft_gate cap round, the gate-coordination detector, `write-gate-context` and `upsert-checkpoint-verdict` share one draft-gate satisfaction fact and one cap-round exit per condition, a self-hosting PR run from the wrong checkout refuses with `toolchain_head_mismatch`, and a reviewer-only delta takes over a sealed `needs_fix` record instead of naming `rm` (#3139)
