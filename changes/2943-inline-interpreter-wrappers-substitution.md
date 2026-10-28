### Fixed

- The inline-interpreter hook refuses `sudo`/`xargs`/`timeout` wrapped heredocs, `$(...)` and backtick substitutions, and `python3 -Ic` flag clusters (#2943)
