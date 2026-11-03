### Fixed

- The Copilot probe no longer returns review or conversation text from non-maintainers, and the review request, withdraw, loop-iteration and request-status checks match the sanctioned Copilot reviewer login exactly, so a lookalike `copilot-x` account no longer makes the loop wait for a review that is never requested (#3034)
