### Changed

- The work-order pull also accepts the execution identity alone, resolved through a new execution index; emitters still emit the 3-flag pointer, so no re-emit is needed (#2551)
- A fixer pull line run with a prefix, suffix, redirect or `cd` is denied with the exact line to run (#2551)
