### Added

- Every `gh` call made through `@dev-loops/core` and the repo scripts appends one line to a shared log under the main checkout `tmp/`; `loop gh-calls` summarizes it by script, PR, minute, GraphQL share and rate-limit refusals; `scripts/release/verify-release-approval.mjs` and `skills/dev-loop/scripts/post-gate-verdict-fallback.mjs` run without `@dev-loops/core` and stay unrecorded (#3338)
