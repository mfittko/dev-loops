### Changed
- The Claude Bash gate denies any `while`, `until` or `for` loop whose body runs `sleep`, whatever its condition (`grep -q`, `pgrep`, `test -f`, command substitution) (#3028)
