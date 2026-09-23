### Fixed

- Fixed an auto-chunked fan-out group deriving a reviewer scope with a doubled
  `group-group-` prefix, and the composed reviewer prompt never stating the
  exact `--scope` value to pass to `verify-fresh-review-context.mjs`, forcing
  a reviewer to hand-derive it. `dispatchUnitScope` now drops the auto-chunk
  unit's leading `group:` marker before sanitizing, and each dispatch unit's
  prompt now states its own emitted scope verbatim, per issue
  [#2372](https://github.com/mfittko/dev-loops/issues/2372).
