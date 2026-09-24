### Changed
- One converged Copilot review now covers later heads; a later code fix needs only the pre-approval gate review, below or at the round cap (#2427)
- A new config setting, `refinement.requireCopilotConvergenceAtLatestHead: true`, restores the rule that each significant change needs a new converged Copilot review (#2427)
- A Copilot body disposition record now clears a merge finding only for the review it names (#2427)
