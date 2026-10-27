### Fixed

- The inline-interpreter guard now refuses a heredoc or stdin script after interpreter flags (`python3 -I - <<EOF`), and the retro check uses the same matcher (#2943)
- The shared segment separator no longer splits on the `&` of a redirection (`2>&1`, `>&2`, `&>f`), so a redirection before a heredoc still reaches the interpreter scan; this segmentation applies to every gate that splits segments (#2943)
