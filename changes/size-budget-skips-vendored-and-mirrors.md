### Fixed
- The size budget skips `.claude/hooks/_vendor/**` and the generated hook mirror files when it counts whole-PR logic LOC, so a vendored dependency swap can open a PR (#2442)
