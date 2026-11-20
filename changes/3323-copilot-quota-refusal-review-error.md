### Fixed

- A Copilot quota refusal ("Copilot was unable to review this pull request ...") now classifies as a review error, so it no longer counts as a Copilot round or yields `round_cap_clean_fallback` (#3323)
