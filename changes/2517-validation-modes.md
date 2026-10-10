### Added
- Gate validation reads a `.devloops` `validation` key: `ci-only` (consumer default) or `local` mode, an optional full-validation command and a path-to-command map (#2517)
- Targeted worker checks read the checkout's `validation.paths`. The gate reads the trusted block from the default branch (`origin/HEAD`, never the checkout's `workflow.baseBranch`) and treats a default branch with no `.devloops` as the `ci-only` default. It refuses a checkout `.devloops` block that differs, so no command comes from a checkout-only edit (#2517)
