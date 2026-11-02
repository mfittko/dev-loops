### Changed

- Delta review results are sealed to their producing run; `loop pre-push-delta --result` and `emit-fixer-work-order --delta-result` refuse an edited, unsealed or foreign result with a typed reason (#2892)
