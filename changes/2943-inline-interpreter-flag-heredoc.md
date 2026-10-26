### Fixed

- The retro tooling check now uses the hook's matcher, which refuses `python3 -I - <<EOF`, `node --require x.js - <<EOF` and bare stdin `-` scripts, including after space-separated value flags such as `node --title x -`, and labels node violations `node inline` (#2943)
