### Added

- The operator focus file now carries a per-thread reply disposition (`tackled`, `partially_fixed`, `deferred`, `rejected`) and a reply note, bound by `fingerprint` on an act-list source or by `threadId` on a threads source (#3206)

### Fixed

- `verify-fixer-disposition.mjs` no longer posts "Fixed in commit" on a thread decided as no code change or only partly fixed; it posts a reply composed from the pinned disposition and note (#3206)
