### Changed

- The fixer receives a compact `dispatchPrompt` from the new `emit-fixer-work-order.mjs` and pulls its work order with `pull-work-order.mjs` (#2420)
- Claude fixer writes outside the pulled work order's branch and allowed paths are denied by the write-guard hook (#2420)
- `verify-fixer-disposition.mjs` takes `--fixer-plan` and requires a matching fixer pull receipt and a post-pull handoff at the observed head (#2420)
- `verify-fixer-disposition.mjs` no longer accepts `--dispositions` or `--dispositions-file` (#2420)
