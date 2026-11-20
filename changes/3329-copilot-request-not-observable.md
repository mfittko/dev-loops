### Fixed

- A Copilot review request that GitHub accepts but never makes observable no longer blocks `pre_approval_gate`: after two such requests and two timed-out probes on one head, loop state reports `copilot_unavailable` (`request_not_observable`) and gate coordination allows `run_pre_approval_gate` with the unavailability noted (#3329)
