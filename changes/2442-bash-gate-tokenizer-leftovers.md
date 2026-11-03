### Fixed

- The Bash gate tokenizer reads `$((1<<2))` as arithmetic and a `EOF)` line inside `$(...)` as closing the heredoc and the substitution (#2442)
