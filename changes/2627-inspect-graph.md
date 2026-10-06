### Changed

- The inspect viewer Graph tab replaces Mermaid with read-only SVG state cards, four layer summaries and keyboard-operable details, zoom, pan, Fit, Focus, Reset and fullscreen controls (#2627)
- Inspect graph layout is automatic and deterministic. Feedback edges follow the left-to-right direction, and wide labels wrap losslessly while Fit/Focus intent survives resizing (#2627)
- Inspect graph uses the shell's light theme under a dark OS preference, and pointer selection focuses the chosen state so keyboard navigation stays aligned (#2627)
- Manual refresh and read-only behavior are unchanged, and snapshot contracts are unchanged. Textual layer details and Snapshot JSON remain if rendering fails. State Atlas keeps Mermaid (#2627)
