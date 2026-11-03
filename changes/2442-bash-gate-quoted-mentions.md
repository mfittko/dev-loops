### Fixed

- The Bash gate no longer denies a single heredoc write, a `git commit -m "$(cat <<'EOF' ...)"` message or quoted text behind a text head (echo, printf, cat, tee, grep, rg, head, tail, wc, sort, test, dev-loops-run) or a node or bun scripts/ runner that only mentions a wait script or interpreter. Quoted text after any other head, `git commit -m` included, keeps the previous split (#2442)
- A `gh` text-flag, `--body-file -` or `git commit -F -` heredoc whose body names an inline interpreter is now denied. Write the body to a file with the editor tool (#2442)
- A multi-segment command, or a heredoc on a head other than cat/tee, whose body holds a backticked or `$(` interpreter mention is now denied; use a single `git commit -m` heredoc (#2442)
