### Changed

- Inline gate findings render in a fixed layout with bounded fields, kept code spans and merged same-defect findings (#2254). Findings merge only when their summaries share at least five words that make up at least 40% of the union, not counting connective words such as "during", and one merged comment holds at most eight findings.
