### Changed
- The secret scan now runs on `@secretlint/core` with the recommended preset instead of the home-built entropy, base64 and sink heuristics, and `merge-pr.mjs` refuses a merge when `origin/<base>...<head>` adds a detected secret (`secret_scan`); the gate reviewer checks for prefixless secrets and secret values written to logs or files (#1858)
