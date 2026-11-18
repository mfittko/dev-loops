### Fixed

- A hung smoke job now fails after at most 45 minutes instead of 360, and the loop re-runs it with `rerun-failed-ci.mjs` without an operator (#3251)
