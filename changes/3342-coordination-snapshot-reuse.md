### Changed

- The gate pre-flight writes one coordination snapshot per PR head; the context writer and verdict poster reuse it for 10 minutes. The poster re-reads head, draft and PR state, PR body, both unresolved thread counts and verdict comments live. CI status, Copilot request and convergence state, the loop interpretation, the base ref and the closing issue references come from the snapshot. (#3342)
