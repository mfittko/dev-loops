# 0270. Operator principles: steer never trap, deterministic fit, ask only operator-owned questions

## Status

Accepted — 2026-11-12 ([PR 3196](https://github.com/mfittko/dev-loops/pull/3196))

## Context

Sources: [issue 3105](https://github.com/mfittko/dev-loops/issues/3105) and tracker [issue 3154](https://github.com/mfittko/dev-loops/issues/3154).

On 2026-11-12 the operator stated that dev-loops must never rely on brittle components to keep agents autonomous. It must steer agents and never leave a state where an orchestrator cannot make the work succeed ([issue 3105 comment](https://github.com/mfittko/dev-loops/issues/3105#issuecomment-6817603526)). Evidence from 2026-11-11 and 2026-11-12 includes a body-only cap-round fix with no exit after the head moved (PR 3179), heuristic shell parsing in the Bash gate that produced new false positives each round (PR 3192), and a secret-scan entropy block that stopped three workers on a public URL path (issue 3167).

The operator then set the test for hand-written checks. The test is the input space and not the patch history. A parser is a library candidate when its input has so many edge cases that it is likely to fail on cases nobody anticipated, even when the parser is new. The options are a maintained library, a narrow check with a stated ceiling, or LLM judgement. The line is fuzzy, and accepting fuzziness is valid ([issue 2442 comment](https://github.com/mfittko/dev-loops/issues/2442#issuecomment-6817661043), [correction](https://github.com/mfittko/dev-loops/issues/2442#issuecomment-6817785200)). The operator applied the same test to the secret scan ([issue 1858 comment](https://github.com/mfittko/dev-loops/issues/1858#issuecomment-6817865004)).

Tracker issue 3154 sets the order: harness fixes first, a docs PR that lands these principles, then issue 3105, and a post-release audit lens that checks each blocking state and each deterministic check against them.

## Decision

1. `PURPOSE-STEER-NOT-TRAP`: every gate, guard or refusal names an exit that the orchestrator can drive to success without the operator, except for operator-owned decisions. A state with no exit is a harness defect, and fixing it outranks feature work.
2. `PURPOSE-DETERMINISTIC-FIT`: a hard, blocking check is allowed only over narrow, well-defined input. Where the input has too many edge cases to anticipate, even for new code, choose a maintained library, a narrow check with a stated ceiling, or LLM judgement with a warning. This covers parsers, classifiers, validators, free-text matchers and gate state rules. Weigh library candidates by edge-case density, consumer install size, runtime (Bun and Node `>=24`, including hooks) and license.
3. `MAIN-AGENT-OPERATOR-QUESTION-SCOPE`: the orchestrator asks the operator only about operator-owned decisions. These are operator-owned lines, ADR acceptance the contract does not settle, scope departures, choices between distinct mechanisms the contracts do not settle, destructive actions, and classifier or permission denials. The orchestrator answers every other question from contracts and judgement and records the source.

The first two rules are children of `PURPOSE-HIGHEST-SAFE-AUTONOMY` in the [contract style guide](../../skills/docs/contract-style-guide.md). The third lives in the [main-agent contract](../../skills/docs/main-agent-contract.md). All three are registered in `skills/docs/required-rules.json` with `doc` enforcement, and AGENTS.md carries one pointer line.

## Alternatives rejected

A single combined rule was rejected. The three principles have different audiences: gate authors, check authors and the orchestrator. Separate IDs let a review cite exactly one.

## Consequences

- Each new gate or refusal needs a named exit, and each new deterministic check needs a stated input ceiling.
- Existing checks that decide over open-ended input become candidates for a library, a narrower check or LLM judgement. Issues 3105, 2442 and 1858 carry those changes. This record changes no code.
- The fit line is fuzzy, so a reviewer judges it case by case. The rules are `doc` enforced, and the post-release audit is the check that they hold.
