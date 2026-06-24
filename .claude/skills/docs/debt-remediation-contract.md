# Debt remediation contract

Canonical authority for the debt remediation pipeline and its integration with the `dev-loop` execution path.

## Pipeline

```
debt_signals → cluster → score → shape → remediation_item → GitHub issue → dev-loop
```

Core pipeline stages under `packages/core/src/debt/`:

| Module | Role | Side effects |
|---|---|---|
| `debt-signal.mjs` | Signal schema and validation | None |
| `cluster.mjs` | Group signals into findings by file, module, theme | None |
| `score.mjs` | 0-100 score from frequency, severity, impact | None |
| `shape.mjs` | Classify findings: remediation_item, debt_epic, defer, watch, dismiss | None |
| `remediation-to-issue.mjs` | Convert remediation_item to GitHub issue payload; create via `gh issue create` | `gh issue create` call |

The cluster, score, and shape stages are deterministic pure functions.
`remediation-to-issue.mjs` performs a side effect (`gh issue create`) and requires GitHub auth.

## CLI entrypoint

`scripts/loop/debt-remediate.mjs` is the single CLI entrypoint routed under `dev-loops loop debt-remediate`.

```
dev-loops loop debt-remediate --input <signals.json> [--repo <owner/name>] [--dry-run]
```

### Contract

- **Input**: JSON array of `debt_signal` objects (validated against `DebtSignalSchema`)
- **Pipeline**: cluster → score → shape → issue creation
- **Issue creation**: calls `gh issue create --assignee @me` for each `remediation_item`
- **Output**: JSON report with counts, issue URLs, and summary
- **Exit codes**: 0 (success — all remediation issue creations succeeded), 1 (argument error, input validation failure, or any issue creation failure)
- **Dry run**: `--dry-run` runs the full pipeline and validates but skips issue creation

### Output shape

```json
{
  "ok": true,
  "dryRun": false,
  "repo": "owner/name",
  "signals": 5,
  "findings": 2,
  "remediationItems": 1,
  "debtEpics": 0,
  "deferred": 1,
  "watching": 0,
  "dismissed": 0,
  "issues": [
    {
      "findingId": "uuid",
      "title": "...",
      "created": true,
      "issueNumber": 123,
      "issueUrl": "https://github.com/owner/name/issues/123",
      "error": null
    }
  ],
  "summary": "5 signals → 2 findings; 1 remediation items (1 issues created, 0 failed); ..."
}
```

## Integration with dev-loop

Once a remediation issue is created, it is a standard GitHub issue that feeds into the existing `dev-loop` execution path:

1. `dev-loops loop startup --issue <n>` resolves the issue
2. Standard `copilot-pr-followup` or `issue_intake` strategy takes over
3. PR → review → merge as normal

This closes the remediation execution loop: `remediation_item → issue → dev-loop → PR → merge`.

## Shape thresholds

Thresholds are hardcoded constants in `shape.mjs`. The outcome for a finding is determined by the combined thresholds:

| Threshold | Value | Outcome |
|---|---|---|
| `EPIC_SIGNAL_COUNT_THRESHOLD` | 3 | When `signalCount > 3` and score ≥ `ITEM_THRESHOLD`, the finding becomes a `debt_epic` instead of `remediation_item` |
| `ITEM_THRESHOLD` | 65 | `remediation_item` (unless signal count pushes to `debt_epic`) |
| `DEFER_THRESHOLD` | 50 | `defer` |
| `WATCH_THRESHOLD` | 30 | `watch` |
| (below) | <30 | `dismiss` |

The `EPIC_SIGNAL_COUNT_THRESHOLD` takes precedence: a finding with score ≥ `ITEM_THRESHOLD` and `signalCount > 3` becomes a `debt_epic`, not a `remediation_item`.

## Scoring model

Three dimensions, weighted:

| Dimension | Weight | Description |
|---|---|---|
| Frequency | 0.35 | Signal count, logarithmic cap |
| Severity | 0.40 | Average severity hint (info=1..critical=5) |
| Impact | 0.25 | File presence, confidence, category diversity |

Clamped to 0-100.

## Labels

Created issues receive the `workflow` label by default. This keeps them discoverable in the standard dev-loop issue tracking surface.
