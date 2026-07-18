import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Regression guard for issue #1405. The intermittent failures actually
// observed in reconcile-draft-gate.test.mjs / detect-checkpoint-evidence.test.mjs
// were shared-coordination-path contamination (a spawned CLI inheriting the
// real cwd and reading the git-common-dir-shared `.pi/runner-coordination`
// state) — fixed in those files by threading `cwd: tempDir`. THIS guard is a
// complementary, forward-looking determinism check for a DIFFERENT hazard:
// reintroducing a real wall-clock read (`Date.now()` / bare `new Date()`)
// into either suite, which would make age/staleness assertions time-dependent
// again by a fresh route. Production seams that need "now" already accept an
// injected value (see each guarded file's header); tests should pass a fixed
// `now` through those instead of reaching for the real clock.
//
// This is a deliberately simple textual heuristic, not a full parser: it
// catches the common real-clock forms (with tolerance for internal
// whitespace and an empty block comment). It does not attempt to defeat
// adversarial obfuscation.
const GUARDED_FILES = [
  "reconcile-draft-gate.test.mjs",
  "detect-checkpoint-evidence.test.mjs",
];

const REAL_CLOCK_PATTERN = /\bDate\s*\.\s*now\s*\(\s*\)|\bnew\s+Date\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)?\)/;

for (const file of GUARDED_FILES) {
  test(`${file} never compares fixtures against the real wall clock`, () => {
    // Resolve relative to THIS guard file (cwd-independent — the guarded
    // files are siblings), so the guard works regardless of the process cwd.
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    assert.doesNotMatch(
      source,
      REAL_CLOCK_PATTERN,
      `${file} must not call Date.now()/new Date() (real time) directly; ` +
        "inject a fixed `now` through the production seam instead (see the file's header comment).",
    );
  });
}
