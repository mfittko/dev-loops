### Changed

- resolve-validation reuses another gate's passing artifact for the same head, profile, toolchain, suites and PR title, stamping `reusedFrom: <gate>`; only the package-suite path reuses; the declared fullCommand path, ci-only mode and the review gate never do (#2508)
