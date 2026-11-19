### Added

- A converged `draft_gate` record survives a later base merge that leaves the PR patch unchanged: `upsert-checkpoint-verdict.mjs --converged-json` accepts the fixer commit when the base-merge carry classifier returns `carry_verdict`, and gate coordination and `merge-pr.mjs` carry the converged verdict from its fixer commit (#2752)
