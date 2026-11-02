### Fixed

- Closing an abandoned gate fix sequence is atomic with fixer pull admission, and fixer liveness uses branch activity with the runner TTL as grace; `close-sequence --head` and the PR `headRefOid` must be a full 40 or 64 character lowercase hex SHA (#2999)
