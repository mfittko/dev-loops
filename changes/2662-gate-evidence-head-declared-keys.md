### Fixed

- The gate-evidence check no longer fails with `config_load_failed` when a PR adds a `.devloops` key that only its own schema knows. A credential-less job reports the keys the PR head declares and the default-branch detector tolerates exactly those keys; a key declared by neither schema still fails (#2662)
