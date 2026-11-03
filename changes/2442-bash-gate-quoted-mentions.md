### Fixed

- The Bash gate no longer denies a single heredoc write or a `git commit -m "$(cat <<'EOF' ...)"` message that only mentions a wait script or interpreter (#2442)
- Quoted wait/interpreter text after echo, printf, cat, tee, grep, rg, head, tail, wc, sort, test, dev-loops-run or a node/bun scripts/ runner passes; other heads keep the old split (#2442)
- A `gh` text-flag, `--body-file -` or `git commit -F -` heredoc whose body names an inline interpreter is now denied. Write the body to a file with the editor tool (#2442)
- A multi-segment command, or a heredoc on a head other than cat/tee, whose body holds a backticked or `$(` interpreter mention is now denied; use a single `git commit -m` heredoc (#2442)
