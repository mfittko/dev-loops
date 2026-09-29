### Changed

- Each gate round runs in a dedicated `gate-coordinator` agent; a Claude Code hook stops the `dev-loop` coordinator from dispatching reviewers or the judge itself (#2531)
