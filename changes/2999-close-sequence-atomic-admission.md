### Fixed

- Closing an abandoned fix sequence is atomic with fixer pull admission; liveness uses branch activity. `close-sequence --head` must be a full 40 or 64 char lowercase hex SHA (#2999)
