### Removed

- The pre-push delta checker `check-pre-push-delta.mjs` and its `loop pre-push-delta` command are removed, with the delta mode of the review agent and six `PRE-PUSH-DELTA-*` rules; the helpers that outlived it moved to `fixer-disposition`, `stale-surface-hits`, `_pre-pr-stale-surface.mjs` and `upsert-checkpoint-verdict.mjs` (#2937)
