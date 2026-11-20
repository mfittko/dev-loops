### Changed

- A clean base merge carries the gate verdict unless the base delta touches a path that can change a gate outcome: reviewer, judge and gate-coordinator agents, gate, judge and review contracts, gate, fan-in, judge, verdict and carry scripts, the dev-loops config or the package manifests. Lockfiles and other tooling paths no longer force a full gate round (#3306, ADR 0295)
