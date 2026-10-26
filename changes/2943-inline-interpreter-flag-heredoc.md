### Fixed

- The inline-interpreter check and the retro tooling check now refuse a heredoc or stdin script after interpreter flags such as `python3 -I - <<EOF` (#2943)
