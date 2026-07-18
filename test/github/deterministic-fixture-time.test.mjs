import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
//
// This is a deliberately simple textual heuristic, not a full parser: it
// catches the common real-clock forms (with tolerance for internal
// whitespace and an empty block comment), which is how the flake would
// realistically reappear. It does not attempt to defeat adversarial
// obfuscation.
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
