### Fixed

- The pre-push push-authority check skips a marker only for another valid repo whose baseline is absent locally, so a fork checkout still fails closed (#3252)
