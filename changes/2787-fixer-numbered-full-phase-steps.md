### Changed

- Fixer full-phase orders state numbered push, CI, `--construct` and verify steps; the verifier builds the THREAD report, refuses hand-written ones and red CI (#2787)
- The verifier CI guard judges only PR-rollup-visible check runs like `wait-pr-checks`; fixer and pre-push contracts say the verifier writes the handoff and posts replies after CI settles (#2787)
