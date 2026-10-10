### Added
- Gate validation reads a `.devloops` `validation` key: `ci-only` (consumer default) or `local` mode, an optional full-validation command and a path-to-command map (#2517)
- Targeted worker checks read the checkout's `validation.paths` at the git repo root. The gate refuses a checkout block that differs from the base branch, so no gate-consumed command comes from a checkout-only edit (#2517)
