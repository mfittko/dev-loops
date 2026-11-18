### Changed

- Gate reviewers read the filtered diff as size-capped parts that each fit one Read, cut at file and hunk boundaries, so the read no longer overflows and forces paging (#3095)
