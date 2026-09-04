# 0059. Use Bun for development while preserving Node consumers and npm publication

## Status

Proposed

## Context

The repository's npm installation, npm-script orchestration, and `node:test`
suites made clean setup and repeated verification slower than desired, while
package-manager assumptions had spread through CI, worktree provisioning,
Playwright setup, container builds, release validation, generated harness
assets, and contributor guidance. [Issue
#1966](https://github.com/mfittko/dev-loops/issues/1966) requires a measured
migration without weakening coverage, changing product behavior, or turning a
developer tool into a package-consumer prerequisite.

The repository publishes two npm packages whose supported execution contract is
Node `>=24`. Its release pipeline also depends on npm-specific registry,
dist-tag, and provenance behavior. Those public and publication boundaries are
separate from the tool used to install and test a source checkout.

## Decision

Pin Bun 1.4.1 exactly as the repository's development package manager,
workspace installer, script runner, and unit-test runner. `bun.lock` is the one
authoritative dependency lockfile, clean installs use `bun install
--frozen-lockfile`, and canonical contributor and CI verification uses `bun run
verify` with all suites attempted, attributable output, and failure propagated.

Keep Node `>=24` as the shipped runtime contract for both published packages.
The public CLI, packaged-consumer smoke tests, inspect-run process behavior, and
Playwright browser tests continue to prove Node execution without requiring Bun
on a consumer machine.

Keep npm as the publication and registry client. Packing, dry-run package
inspection, registry queries, dist-tag selection, and `npm publish
--provenance` remain npm commands. Intentional npm/npx consumer-install and CLI
examples remain valid and must not be mechanically rewritten as Bun commands.

We reject making Bun a published runtime dependency because that would change
the consumer contract. We also reject replacing npm in the release boundary:
Bun does not substitute for the established npm provenance and dist-tag flow.
Finally, the toolchain does not become authoritative merely because it is
configured; the compatibility and performance gate in issue #1966 must pass on
comparable evidence or the migration records a no-go.

## Consequences

Contributors and CI get one pinned installer, script runner, test runner, and
lockfile. Frozen installs fail on manifest/lock drift, and documentation must
clearly label the remaining Node and npm commands by boundary so future cleanup
does not erase necessary consumer or release coverage.

The repository must maintain explicit Node 24 packaged-consumer, public-CLI,
inspect-run, and Playwright evidence alongside Bun-run development tests. The
release workflow must continue to test npm package contents and use npm for
registry publication and provenance. Benchmark evidence remains a release gate:
failed correctness parity, unequal dependency graphs, inadequate install
improvement, or insufficient independent verification wins means no-go rather
than weakened validation or a manufactured speedup.
