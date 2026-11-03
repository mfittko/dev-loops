### Fixed

- The Bash gate no longer denies a single heredoc write, a `git commit -m "$(cat <<'EOF' ...)"` message or quoted text that only mentions a wait script or interpreter (#2442)
- A `gh` text-flag, `--body-file -` or `git commit -F -` heredoc whose body names an inline interpreter is now denied. Write the body to a file with the editor tool (#2442)
