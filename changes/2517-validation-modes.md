### Added
- Gate validation reads a `.devloops` `validation` key: `ci-only` (consumer default) or `local` mode, an optional full-validation command and a path-to-command map (#2517)
- Targeted worker checks read the checkout's `validation.paths`. The gate trusts only the default-branch `validation` block and refuses a checkout block that differs (#2517)
