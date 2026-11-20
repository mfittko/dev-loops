### Fixed

- A Copilot "unable to review this pull request" body, such as the quota refusal, classifies as a review error, so it no longer counts as a round or yields `round_cap_clean_fallback` (#3323)
