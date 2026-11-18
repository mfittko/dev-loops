### Fixed

- The pre-push push-authority check skips a marker of another repo whose baseline is absent locally, and refuses on a git failure, so a fork checkout still fails closed (#3252)
