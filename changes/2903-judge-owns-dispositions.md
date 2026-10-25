### Changed

- The judge owns every finding disposition, the review verdict and the next action; fan-in leaves findings `unjudged` (#2903)
- The standalone `review` gate never resolves the `gate-evidence` angle, and the judge rejects template-only findings (#2903)
- `@dev-loops/core/loop/gate-fanin` no longer exports `deriveDisposition` or `isDefaultDeferrableSeverity`; fan-in leaves findings unjudged (#2903)
