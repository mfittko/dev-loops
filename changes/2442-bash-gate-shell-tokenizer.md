### Changed

- The Bash gate now fails closed on unterminated quotes, `$(` and heredocs and on quote-pairing hazards; a shell-word tokenizer backs it (#2442)
