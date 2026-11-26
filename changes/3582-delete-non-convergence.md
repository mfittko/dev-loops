### Fixed

- The non-convergence brake is deleted: a raw act count stopped lanes that were converging. The round cap and the growth brake stay (#3582)
- The fanout and judge emitters accept the operator focus file with `items` and use only its `round`; the runbook passes one `FOCUS` file to steps 3, 7 and 11 (#3590)
