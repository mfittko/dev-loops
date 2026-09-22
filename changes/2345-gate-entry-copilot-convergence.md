### Fixed

- **The pre_approval gate-entry coordinator now uses the merge gate's shared Copilot convergence evaluation (issue [#2345](https://github.com/mfittko/dev-loops/issues/2345)).** A thread-clean current-head 🔵 "Needs a closer look" review no longer forbids pre_approval entry, while unresolved threads and a 🟡 "Changes recommended" review still block it. The shared evaluator accepts the REST and GraphQL review shapes used by both production call sites.
