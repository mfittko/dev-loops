### Changed
- The generated pre-commit hook prints secret-scan candidates to stderr and no longer blocks the commit; the merge gate's `secret_scan` precondition blocks (#1858)
