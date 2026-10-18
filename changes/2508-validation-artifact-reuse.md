### Changed

- resolve-validation reuses a passing artifact from another lifecycle gate for the same head, profile, toolchain, suites and PR title, stamping `reusedFrom: <gate>`; the review gate never reuses (#2508)
