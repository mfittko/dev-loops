### Fixed

- The gate-evidence check no longer fails with `config_load_failed` when a PR adds a `.devloops` key that only its own schema knows. A credential-less job on `pull_request` events reports the keys the PR head declares and uploads them as an artifact. The default-branch detector tolerates exactly those keys, reading the artifact as validated data on `issue_comment` events, where PR head code never runs. A key declared by neither schema still fails (#2662)
