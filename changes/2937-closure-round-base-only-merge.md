### Fixed

- A base-only merge after the draft gate cap round no longer blocks the closure fixer order; the closure diff holds only PR-own changes, else `closure_delta_no_pr_own_change` (#2937)
