### Fixed

- The retro tooling check now uses the hook's matcher, which refuses `python3 -I - <<EOF` and `node --require x.js - <<EOF` heredocs (#2943)
