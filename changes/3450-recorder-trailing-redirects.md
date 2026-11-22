### Fixed

- The operator-decision-recorder hook ignores simple output redirections such as `2>&1` and `>/dev/null` at the end of a command segment, so `dev-loops-run cli/index.mjs --help 2>&1 | head` is no longer denied (#3450)
