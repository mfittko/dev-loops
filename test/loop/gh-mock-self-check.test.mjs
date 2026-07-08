import assert from "node:assert/strict";
import test from "node:test";

import { makeGhMock } from "../_helpers.mjs";

// makeGhMock underpins the in-process gh-call assertions across the loop suite.
// Only its PASS side is exercised by those tests, so a port bug in a guard
// branch (e.g. an inverted assertArgs condition) would silently stop enforcing
// and false-green every consumer. This self-check pins the failure/guard exit
// codes and the hermetic defaults so the mock's own enforcement can't rot.

test("matching assertArgs returns stdout with code 0 and records the call", async () => {
  const { runChild, calls } = makeGhMock([
    { assertArgs: ["pr", "view"], stdout: "OK\n" },
  ]);
  const result = await runChild("gh", ["pr", "view", "123"], {}, "");
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "OK\n");
  assert.deepEqual(calls, [{ command: "gh", args: ["pr", "view", "123"], stdinText: "" }]);
});

test("mismatched assertion branches return their distinct exit codes", async () => {
  const cases = [
    [{ assertArgs: ["missing"] }, ["pr", "view"], "", 98],
    [{ assertArgContains: ["needle"] }, ["haystack"], "", 94],
    [{ assertArgNotContains: ["boom"] }, ["boom-arg"], "", 93],
    [{ assertStdinIncludes: ["expected"] }, ["pr"], "other", 96],
  ];
  for (const [entry, args, stdin, expectedCode] of cases) {
    const { runChild } = makeGhMock([entry]);
    const result = await runChild("gh", args, {}, stdin);
    assert.equal(result.code, expectedCode, `entry ${JSON.stringify(entry)}`);
  }
});

test("sequence overflow honors repeatLastOnOverflow", async () => {
  const withoutRepeat = makeGhMock([{ stdout: "first\n" }]);
  await withoutRepeat.runChild("gh", ["a"], {}, "");
  const overflow = await withoutRepeat.runChild("gh", ["b"], {}, "");
  assert.equal(overflow.code, 97);

  const withRepeat = makeGhMock([{ stdout: "last\n" }], { repeatLastOnOverflow: true });
  await withRepeat.runChild("gh", ["a"], {}, "");
  const repeated = await withRepeat.runChild("gh", ["b"], {}, "");
  assert.equal(repeated.code, 0);
  assert.equal(repeated.stdout, "last\n");
});

test("git resolves hermetically and any other command throws", async () => {
  const { runChild } = makeGhMock([]);
  const git = await runChild("git", ["status", "--porcelain"], {}, "");
  assert.deepEqual(git, { code: 0, stdout: "", stderr: "" });

  await assert.rejects(() => runChild("curl", ["https://example.com"], {}, ""), /unexpected command/);
});
