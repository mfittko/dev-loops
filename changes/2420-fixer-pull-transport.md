### Changed

- The fixer receives a compact `dispatchPayload` from the new `emit-fixer-work-order.mjs --harness <claude|pi>` and pulls its work order with `pull-work-order.mjs` (#2420)
- Claude fixer writes outside the pulled work order's branch and allowed paths, and fixer `git commit`/`git push` on another branch, are denied by the hooks (#2420)
- `verify-fixer-disposition.mjs` takes `--fixer-plan` and requires a digest-bound plan, a matching fixer pull receipt, a post-pull handoff and the live PR head (#2420)
- `verify-fixer-disposition.mjs` no longer accepts `--dispositions` or `--dispositions-file` (#2420)
