import assert from "node:assert/strict";
import { test } from "bun:test";

import { formatCliError as pure } from "../../scripts/lib/format-cli-error.mjs";
import { formatCliError as canonical } from "@dev-loops/core/github/review-threads";

// scripts/lib/format-cli-error.mjs is a node:-builtins-only copy of the
// canonical formatter, so scripts/lib/jq-output.mjs (on the release-script
// import closure) can format CLI errors without pulling in @dev-loops/core.
// A copy risks drift; this pins the pure copy byte-for-byte against the
// canonical export across the shapes formatCliError distinguishes — the same
// drift-guard pattern test/docs/direct-run-predicate.test.mjs applies to the
// direct-run copy.

const usageError = Object.assign(new Error("bad flag"), { usage: "USAGE: ..." });
const CASES = [
  new Error("plain failure"),
  usageError,
  "a bare string error",
  { toString: () => "objecty" },
];

test("pure formatCliError matches the canonical export for every error shape", () => {
  for (const err of CASES) {
    assert.equal(pure(err), canonical(err), `mismatch for: ${String(err)}`);
  }
});

test("pure formatCliError matches the canonical export when a usage string is passed via options", () => {
  const err = new Error("no usage on the error itself");
  assert.equal(pure(err, { usage: "USAGE: ..." }), canonical(err, { usage: "USAGE: ..." }));
  assert.equal(pure(err), canonical(err));
});
