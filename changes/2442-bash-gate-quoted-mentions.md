### Fixed

- The Bash gate no longer denies a single `cat`/`tee` heredoc write, a `git commit -m "$(cat <<'EOF' ...)"` message, or quoted text that only mentions a wait script, loop keyword or interpreter. A heredoc in any multi-segment command keeps every body visible (#2442)
