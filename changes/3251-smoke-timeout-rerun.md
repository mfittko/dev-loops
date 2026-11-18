### Fixed

- A hung smoke job now fails after at most 45 minutes (35 for WebKit setup, 10 for the run step) instead of 360, and the loop re-runs it with `rerun-failed-ci.mjs` instead of waiting for an operator (#3251)
