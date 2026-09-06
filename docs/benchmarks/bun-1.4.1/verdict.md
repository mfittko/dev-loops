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
(8,081 pass, 36 skip); npm's 341 files exclude five migration tests.

Workspace links, peer metadata, shared versions, and lifecycle declarations
matched. Expected tree differences were removed obsolete tooling and
incompatible-platform optional binaries. Both sessions passed the 50%
warm-install and 5/7 verification gates; raw observations accompany this file.
