### Fixed
- The gate verdict body shows act and blocking findings, folds the rest by judge disposition into one Details block, and drops the PR deferral comment (#2722)
- Inline gate finding comments keep one short Problem and Fix, with only the remainder under Details (#2722)
- A rerun of the gate verdict upsert with an inline reason holding an HTML comment delimiter reports noop, and the hidden lines also neutralize `--!>` (#2722)
