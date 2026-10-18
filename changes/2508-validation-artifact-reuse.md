### Changed

- resolve-validation reuses another gate's passing artifact for the same head, profile, toolchain, suites and PR title, stamping `reusedFrom: <gate>`; the review gate never reuses (#2508)
