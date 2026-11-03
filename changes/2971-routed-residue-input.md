### Added

- `consolidate-fanin.mjs --operator-focus-file` accepts operator-routed residue and records it as findings under the declared angle `operator-routed-residue`, with a `source: "operator-focus"` provenance entry (`GATE-EXEC-ROUTED-RESIDUE-INPUT`, #2971)
- The durable findings-log write persists the residue provenance entry and exempts only an `operator-focus` entry with a 64-hex digest from reviewer pairing, emit-plan unit matching and the foreign-angle check. `operator-routed-residue` is a reserved angle, residue requires `--emit-plan`, and a residue severity is validated against the valid severities (#2971)
