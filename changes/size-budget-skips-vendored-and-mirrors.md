### Fixed
- The size budget no longer counts `.claude/hooks/_vendor/**` or the generated hook mirror files as whole-PR logic LOC, so a vendored dependency swap no longer fails `size_split_required_before_pr`
