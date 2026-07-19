# 0002. One gate reviewer per fresh angle, enforced at write and read time

## Status

Accepted

## Context

Gate fan-outs had drifted toward grouping several review angles into fewer reviewer agents to save tokens, ending in a single reviewer covering five pre-approval angles — a self-approval shape that defeats the independence the fan-out exists to buy. The operator ordered a root-cause fix and hardening ([issue 1431](https://github.com/mfittko/dev-loops/issues/1431)).

## Decision

Each fresh review angle gets exactly one scoped reviewer. The pairing is machine-enforced twice: at write time the findings-log writer rejects provenance whose fresh angles do not map one-to-one onto distinct recorded reviewer identities, and at read time the checkpoint-evidence detector re-validates the pairing and scales the minimum-distinct-reviewer floor to the fresh-angle count. Angles whose surface is unchanged at a new head may carry prior findings (`carriedFromHead`) and are exempt from the pairing requirement. Rejected alternatives: advisory-only contract text (already proven to drift), and grouping with a declared cap (still a self-approval shape at the cap).

## Consequences

Fan-out reviews cost more tokens but their independence is verifiable from the ledger, not asserted. The sanctioned cheap paths remain `inline_single_agent` and light-mode dispatch. The floor caught its author's own miscounted provenance within hours of shipping.
