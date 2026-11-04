### Changed

- Gate coordination blocked results now name who decides (`blockedOn`, where `operator_decision` is a slice 1 catch-all for results with no runnable remedy that slice 9 narrows) or a runnable remedy command, and a walker test guards the invariant through the shared `@dev-loops/core/loop/gate-no-dead-end` predicate (#3105)
