### Changed
- A config load error no longer relaxes a gate: startup returns needs_reconcile with a configError, and every gate script that used a default now fails closed with config_load_failed (#2612)
- Generated Claude forms run `dev-loops-run cli/index.mjs` instead of a pinned `npx dev-loops@<version>`, so a dev-loops checkout runs its own code (#2612)
