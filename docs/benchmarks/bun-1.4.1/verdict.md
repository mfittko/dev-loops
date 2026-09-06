# Bun 1.4.1 migration verdict

Verdict: **pass**.

The committed sessions are the frozen historical npm baseline. They were captured
on AC-powered Apple M5 Max/macOS arm64 with Node v26.3.0, npm 11.19.0, isolated
caches, and stable source fingerprints; they are not current-head reruns.

| session | npm/Bun cold install | npm/Bun warm install | npm/Bun verify | Bun wins |
|---|---:|---:|---:|---:|
| 1 | 2.092/1.205s | 1.636/0.312s (19.0%) | 88.860/56.864s | 7/7 |
| 2 | 2.135/1.234s | 1.656/0.329s (19.8%) | 87.196/55.755s | 7/7 |

The frozen npm verify medians are 88.860s and 87.196s. Its warm-install medians
remain 1.636s and 1.656s; the recorded Bun candidate was 19.0–19.8% of those.

One fresh candidate run on implementation head `8e4025588651587c0d24fbee4aead408fc64c562`
used Bun 1.4.1, Node v26.7.0, `BUN_TEST_PARALLELISM=8`, and `LANG`/`LC_ALL=C.UTF-8`
on the same AC-powered Apple M5 Max/macOS arm64 machine. It passed 8,138 tests,
skipped 35, failed 0, covered 349 files, and the complete Bun test inventory's
runner wall time was 58.60s. That is 32.8% faster than the faster frozen npm
median; docs and workflow validators also passed, and no baseline test was omitted.

The one-off capture/analyzer harness was removed. Raw frozen-baseline observations
remain alongside this verdict; current candidates require one fresh complete run.
