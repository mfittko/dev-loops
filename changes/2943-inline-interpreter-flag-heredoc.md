### Fixed

- The inline-interpreter guard now refuses a heredoc or stdin script after interpreter flags (`python3 -I - <<EOF`), and the retro check uses the same matcher (#2943)
- The shared segment separator keeps the `&` of a redirection (`2>&1`, `&>f`) in its segment so a redirection before a heredoc reaches the scan; every segment-splitting gate shares it (#2943)
