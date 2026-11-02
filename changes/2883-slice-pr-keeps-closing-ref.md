### Fixed

- The judge no longer acts on removing a slice PR's only closing reference (#2883)

### Changed

- emit-judge-work-order requires --pr-body-file and refuses with pr_body_file_required without it; the file must match the PR body in the pinned gate-context evidence or the emitter refuses with pr_body_mismatch (#2883)
