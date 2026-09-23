### Changed

- **Every gate review round now runs in a dedicated fresh-context gate coordinator agent (issue [2370](https://github.com/mfittko/dev-loops/issues/2370)).** The gate-review sub-loop contract adds `GATE-EXEC-GATE-COORDINATOR` as the only sanctioned round shape, and the dev-loop agent's sub-loop line now names the gate coordinator explicitly.
