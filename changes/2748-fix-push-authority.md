### Added

- A git pre-push check refuses a push of a gate fix commit until the full work order is emitted; `check-pre-push-delta --pr-head` fails on a moved PR head (#2748). The hook is the only enforcement layer: a checkout with `core.hooksPath` set or a foreign `pre-push` hook has no such check, and `ensure-worktree` warns about it
