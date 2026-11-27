### Changed

- `emit-fanout-dispatch.mjs --pending --retry-crashed <unit>` tells a named crashed unit to pass `--same-head-retry`, so its stale sentinel no longer blocks it (#3642)
