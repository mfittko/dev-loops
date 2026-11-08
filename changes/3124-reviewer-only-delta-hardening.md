### Fixed
- The reviewer-only pre-push delta route reads the PR base for its fetch, refuses a gitlink the patch omits, and adds the merge remerge diff to the reviewer patch; `input.patchPath` is now the run-bound `<baseline>-<candidate>-<runId>.patch` and the `locally_clear` refusal text names `PRE-PUSH-DELTA-RESIDUE` (#3124)
