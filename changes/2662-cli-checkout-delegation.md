### Fixed
- The installed `dev-loops` CLI runs the source checkout's CLI for `gate`, `loop` and `pr`, so an older installed CLI no longer decides gates with stale code; a version difference is named on stderr (#2662)
