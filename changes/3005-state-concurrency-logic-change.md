### Changed

- Logic-change draft rounds now run the `state-concurrency` review angle, extended with precondition, ownership-binding and liveness checks (#3005)
- The gate reviewer brief now asks for a sibling sweep after a finding: the opposite direction, concurrent invocation, alternate input forms and every call site of a fix (#3005)
- The gate context now adds the importers and sibling functions of a changed exported function, state writer or guard, bounded by `gates.contextExpansion` (`maxFiles` 6, `maxBytes` 98304), and the briefing lists the files the cap dropped (#3005)
