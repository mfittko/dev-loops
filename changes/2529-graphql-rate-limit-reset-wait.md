### Changed

- `wait-pr-checks` and `spec-context` wait for the GraphQL rate-limit reset and retry once when the GraphQL budget is exhausted; otherwise they return `RATE_LIMITED` with `resetAt` at once (#2529)
