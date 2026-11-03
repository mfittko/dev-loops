### Changed
- The Claude Bash gate denies any `while`, `until` or `for` loop whose body runs `sleep`, whatever its condition (`grep -q`, `pgrep`, `test -f`, command substitution), also behind wrappers, function bodies, process substitutions and `sh|bash|zsh|dash|ksh -c` payloads; the check is whole-command (#3028)
