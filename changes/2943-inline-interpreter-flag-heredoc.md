### Fixed

- The inline-interpreter guard now refuses a heredoc or stdin script after interpreter flags (`python3 -I - <<EOF`), and the retro check uses the same matcher (#2943)
