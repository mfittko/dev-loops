### Changed

- A `--pending` fan-out emission tells each redispatched unit to pass `--same-head-retry`, so a crashed unit's stale sentinel no longer blocks it (#3642)
