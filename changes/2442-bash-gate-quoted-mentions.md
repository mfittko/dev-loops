### Fixed

- The Bash gate no longer denies a single heredoc write, a `git commit -m "$(cat <<'EOF' ...)"` message or quoted text that only mentions a wait script or interpreter (#2442)
