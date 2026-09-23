### Changed

- **The Claude-harness pre-PR reviewer model in this repo's `.devloops` is now `opus` (Opus 5.5) instead of `fable` (issue [#2367](https://github.com/mfittko/dev-loops/issues/2367)).** Opus 5.5 reviews code at the level of Fable at lower cost. The `pre-pr-strong` tier keeps an explicit pin, and the Pi-harness value is unchanged. ADR 0082 (`docs/decisions/0082-pre-pr-reviewer-opus.md`) records the change and amends ADR 0079.
