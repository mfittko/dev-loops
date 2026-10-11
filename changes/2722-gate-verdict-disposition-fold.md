### Fixed
- The gate verdict body shows act and blocking findings, folds the rest by judge disposition into one Details block, and drops the PR deferral comment (#2722)
- Inline gate finding comments keep one short Problem and Fix, with only the remainder under Details (#2722)
- A rerun of the gate verdict upsert with an inline reason holding an HTML comment delimiter reports noop, and the hidden lines also neutralize `--!>` (#2722)
- A locatable gate finding at or above the inline floor keeps its inline thread whatever its judge disposition; every other finding, locatable or not, folds by disposition (#2722)
- The fallback gate verdict poster renders the Blocking severities line inside a hidden HTML comment (#2722)
