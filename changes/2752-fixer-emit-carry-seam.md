### Changed
- The fixer work-order emitter accepts a gate verdict posted at an earlier head when the PR's own files are byte-identical at both heads, and does not carry a verdict across a head that ran its own gate round (#2752)
