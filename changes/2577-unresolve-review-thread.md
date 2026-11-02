### Added

- Add the sanctioned `unresolve-review-thread.mjs` wrapper with named refusals; the hook allows it for the main agent and the `dev-loop` coordinator and denies every other agent type, including fixer, review and judge (#2577)
- Add `GATE-EXEC-ROUND-CAP-NO-DECLINE-RESOLVE`: fix high and medium cap-round findings via the thread route; the resolved-thread refusal names the unresolve script (#2577)
