### Added
- `pr create` and `loop gate-coordination` report the ADR tripwire and size budget for draft PRs, and gate coordination stops with `resolve_adr_tripwire` or `resolve_size_budget` before the ready flip; `pr create` stdout gains a trailing `adrTripwire`/`sizeBudget` JSON line after the PR URL (#2512)
