### Fixed

- The Bash gate no longer denies a single heredoc write, a `git commit -m "$(cat <<'EOF' ...)"` message or quoted text that only mentions a wait script or interpreter (#2442)

### Changed

- A `gh` text-flag substitution heredoc, or a `--body-file -` or `git commit -F -` stdin heredoc, whose body names an inline interpreter is now denied. Write the body to a file with the editor tool instead (#2442)
