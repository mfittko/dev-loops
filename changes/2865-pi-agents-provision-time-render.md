### Fixed

- `.pi/agents` is untracked and rendered with Pi-valid tools at worktree provision time; a subagent launch on an unrendered agent set is refused with `agent_set_not_rendered` (#2865)
- A fresh dev-loops clone gets `.pi/agents` rendered at the first Pi session start (#2865)
