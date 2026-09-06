# Bun 1.4.1 migration verdict

Verdict: **pass**.

Two independent sessions ran on AC-powered Apple M5 Max/macOS arm64 with Node
v26.3.0, npm 11.19.0, Bun 1.4.1, `BUN_TEST_PARALLELISM=8`, isolated/reset
temporary directories, 15-second settling, and stable source fingerprints.

| session | npm/Bun cold install | npm/Bun warm install | npm/Bun verify | Bun wins |
|---|---:|---:|---:|---:|
| 1 | 2.092/1.205s | 1.636/0.312s (19.0%) | 88.860/56.864s | 7/7 |
| 2 | 2.135/1.234s | 1.656/0.329s (19.8%) | 87.196/55.755s | 7/7 |

All commands passed without timeout. Bun ran 8,117 tests across 346 files
(8,081 pass, 36 skip). Its inventory is the complete npm baseline plus exactly
five Bun-migration contract files, so no baseline test is omitted.

The declared graph, workspace links, peer metadata, shared versions, and shared
lifecycle declarations matched. Expected installed-tree differences were
obsolete npm-only tooling and incompatible-platform optional binaries. Both sessions passed the 50%
warm-install and 5/7 verification gates; raw observations accompany this file.

Final unified-queue sampling recorded three green verifies at 56.46/55.92/60.30s
(median 56.46s), 25.3–25.9 average and 35 peak descendants, and conservative
aggregate RSS of 1.21–1.24 GiB average / 2.10–2.32 GiB peak (shared pages included).
