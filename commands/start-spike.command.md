---
description: Start a time-boxed dev-loop spike from a question (or a pre-authored findings file).
argument-hint: "<question> | --file <path>"
---
Start a spike — a time-boxed exploration whose deliverable is a findings document. Two forms; both end in `loop startup --spike <path>` and hand the bundle to the `dev-loop` skill. Do NOT pick an internal strategy yourself, and do NOT invent new spike behavior — this wraps the shipped `--spike` intake (see `skills/docs/spike-mode-contract.md`).

- Inline question (`$ARGUMENTS` is free text, not `--file ...`): scaffold a startable findings artifact, then enter spike mode.
  - Pick a local spike path (e.g. `docs/spikes/<slug>.md` derived from the question; do not overwrite an existing file).
  - Run `node scripts/refine/scaffold-spike-file.mjs --question "$ARGUMENTS" --out <path> --json`. It writes `## Question` (from the arg) plus stubbed `## Approach`/`## Findings` so the exploration scaffold passes `validateSpikeExplorationSections`; `## Recommendation` is left for the spike to fill in. It returns `{ ok: true, path, question }`.
  - Then run `node scripts/loop/resolve-dev-loop-startup.mjs --spike <path>` and route the resulting bundle through the `dev-loop` skill.

- Pre-authored file (`$ARGUMENTS` begins with `--file <path>`): skip scaffolding and run `node scripts/loop/resolve-dev-loop-startup.mjs --spike <path>` directly, then route. The file must already carry the exploration scaffold (Question/Approach/Findings).

The spike runs under the relaxed `gates.spike` profile. When the exploration reaches a `## Recommendation`, conclude it with `node scripts/refine/exit-spike.mjs --spike-file <path> --disposition <discard|graduate> [--plan-file <path>]` per the spike-mode contract — discard leaves nothing behind, graduate emits a plan file into the local-planning flow. No new routing logic here.
