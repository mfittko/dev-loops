### Fixed

- Judge-rejected medium and low gate threads are reject-closed only when every finding marker on a merged thread is judge-rejected. The fixer act-thread guard matches every marker of a merged thread, and `emit-fixer-work-order.mjs` refuses an act item with a missing or non-canonical fingerprint (#2485)
