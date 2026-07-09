import { assert, readRepo, test } from "../imported-assets-helpers.mjs";

// Guards against the CI verify-suite matrix drifting from the test:* scripts
// that compose `npm run verify`. Adding a gating suite to package.json without
// wiring the matrix (or vice-versa) is fail-open: the aggregate verify gate
// stays green while the new suite never runs. This asserts the two sets match.

const suiteTokens = (text) =>
  new Set((text.match(/test:[\w:-]+/g) || []));

test("verify-suite matrix suites equal the test:* suites composing npm run verify", async () => {
  const [pkgRaw, ciWorkflow] = await Promise.all([
    readRepo("package.json"),
    readRepo(".github/workflows/ci.yml"),
  ]);

  // Source of truth: the run-p args of the `verify` script (the aggregate CI
  // gate). run-p flags never start with `test:`, so token-matching is exact.
  const verifyScript = JSON.parse(pkgRaw).scripts?.verify;
  assert.ok(verifyScript, "package.json must define a `verify` script");
  const verifySuites = suiteTokens(verifyScript);

  // Scope to the verify-suite job's own section (header to the next top-level
  // job header) so a suite name elsewhere in the workflow can't satisfy this.
  const headerIndex = ciWorkflow.search(/^\s{2}verify-suite:\s*$/m);
  assert.ok(headerIndex !== -1, "ci.yml must define a verify-suite: job");
  const nextJobRelative = ciWorkflow.slice(headerIndex + 1).search(/^\s{2}\S/m);
  const section = ciWorkflow.slice(
    headerIndex,
    nextJobRelative === -1 ? ciWorkflow.length : headerIndex + 1 + nextJobRelative,
  );
  const matrixSuites = new Set(
    [...section.matchAll(/^\s*-\s*(test:[\w:-]+)\s*$/gm)].map((m) => m[1]),
  );

  const missingFromMatrix = [...verifySuites].filter((s) => !matrixSuites.has(s));
  const extraInMatrix = [...matrixSuites].filter((s) => !verifySuites.has(s));

  assert.deepEqual(
    missingFromMatrix,
    [],
    `test:* suites in \`npm run verify\` but missing from the ci.yml verify-suite matrix: ${missingFromMatrix.join(", ")}`,
  );
  assert.deepEqual(
    extraInMatrix,
    [],
    `suites in the ci.yml verify-suite matrix but not in \`npm run verify\`: ${extraInMatrix.join(", ")}`,
  );
});
