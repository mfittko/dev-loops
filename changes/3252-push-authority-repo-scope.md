### Fixed

- The pre-push push-authority check skips a marker only for another valid repo (the push URL's repo, else origin) whose baseline is absent locally, even for a same-named branch, so a fork checkout still fails closed and a git failure refuses (#3252)
