import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// Regression guard for issue #1405: reconcile-draft-gate.test.mjs and
// detect-checkpoint-evidence.test.mjs carried fixtures that encoded fixed
// past timestamps but got their "now" from the real wall clock, so
// assertions about age/staleness silently flipped as real time advanced.
// Both files use fixed, self-consistent fixture timestamps and must never
// call the real clock directly — a literal `Date.now()` or bare
// `new Date()` (no args) is exactly how that flake reappears. Production
// seams that need "now" already accept an injected value (see each guarded
// file's header comment); tests should pass a fixed `now` through those
// instead of reaching for the real clock.
const GUARDED_FILES = [
  "reconcile-draft-gate.test.mjs",
  "detect-checkpoint-evidence.test.mjs",
];

const REAL_CLOCK_PATTERN = /Date\.now\(\)|new Date\(\s*\)/;

for (const file of GUARDED_FILES) {
  test(`${file} never compares fixtures against the real wall clock`, () => {
    const source = readFileSync(path.resolve("test/github", file), "utf8");
    assert.doesNotMatch(
      source,
      REAL_CLOCK_PATTERN,
      `${file} must not call Date.now()/new Date() (real time) directly; ` +
        "inject a fixed `now` through the production seam instead (see the file's header comment).",
    );
  });
}
