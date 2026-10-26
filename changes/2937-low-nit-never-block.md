### Changed

- Low and nit findings no longer block a gate round or reach the fixer; the judge defers or rejects them unless it marks them fail-open (#2937)
- The autonomy principles are contract rules with one owner each, and the low/nit refusal carries the typed code `low_nit_never_blocks` (#2937)
