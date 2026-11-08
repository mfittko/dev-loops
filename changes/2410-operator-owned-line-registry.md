### Fixed
- One operator-owned-line registry in `@dev-loops/core` makes every sanctioned comment writer refuse `approve merge`, `approve release v<version>`, `adr-tripwire:allow` and the Copilot body-disposition `operator` marker, using the same markdown strip as the release-approval reader (#2410)
