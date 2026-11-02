# 0225. The CLI delegates gate, loop and pr to the source checkout

## Status

Accepted — 2026-11-02 ([issue 2662](https://github.com/mfittko/dev-loops/issues/2662))

Amends nothing. It extends the intent of [0118](./0118-launcher-resolves-cli-forms.md) from the launcher to the bare `dev-loops` binary.

## Context

A bare `dev-loops` binary on PATH can be older than the dev-loops checkout it runs in. The older CLI does not know a newer `.devloops` key, so it drops the `.devloops` layer and fails closed with a config load error (`CONFIG-LOAD-FAIL-CLOSED`) that the flow could not tell apart from a real config defect. The installed CLI also rejects flags it does not know.

## Decision

- For the `gate`, `loop` and `pr` categories, `cli/index.mjs` finds the nearest `dev-loops` checkout above the working directory. When that checkout is not the running CLI's root, the CLI spawns the checkout's `cli/index.mjs` with the same argv and working directory, and returns its exit status.
- The child runs with `DEVLOOPS_CHECKOUT_DELEGATED=1`. A non-empty variable disables delegation, so the checkout CLI never delegates again.
- The CLI writes a stderr notice only when the installed and checkout versions differ. When the checkout CLI does not start, the CLI exits 1 with a `cli_version_skew` line that names the `dev-loops-run --repo-root` rerun command.
- Other categories (`doctor`, `--version`, top-level help) run in the installed CLI.

Rejected: refusing to run on a version skew. The checkout code is the intended code, so running it gives the operator the right behavior without a manual rerun.

## Consequences

An installed CLI behind a checkout gives the checkout's gate and loop behavior. A run outside any checkout is unchanged. The rule is `CLI-CHECKOUT-DELEGATION` in the artifact authority contract.
