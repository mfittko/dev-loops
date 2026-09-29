### Changed

- Worker dispatch pulls by execution identity alone and the old 3-flag pull exits 2; re-emit in-flight rounds after the upgrade (#2551)
- A fixer pull line run with a prefix, suffix, redirect or `cd` is denied with the exact line to run (#2551)
