import assert from "node:assert/strict";
import { test } from "bun:test";
import { commandContainsInlineInterpreter } from "@dev-loops/core/loop/bash-command-classify";

// OPS-NO-INLINE-INTERPRETER verdict table. perl/ruby/deno are outside the pinned toolchain and
// are recorded as deliberately uncovered (false).
const CASES = [
  ["node -e 'x'", true],
  ["node --eval 'x'", true],
  ["node - <<EOF", true],
  ["node scripts/x.mjs", false],
  ["python -c 'x'", true],
  ["python3 -c 'x'", true],
  ["python3 - <<EOF", true],
  ["python3 script.py", false],
  ["bun -e 'x'", true],
  ["bun --eval 'x'", true],
  ["bun -p '1'", true],
  ["bun --print '1'", true],
  ["bun -", true],
  ["bun <<EOF", true],
  ["bun - <<EOF", true],
  ["FOO=1 /usr/local/bin/bun -e 'x'", true],
  ["env bun --cwd /w -e 'x'", true],
  ["bun --env-file .env -r ./pre.ts -p '1'", true],
  ["bun run x", false],
  ["bun test", false],
  ["bun install", false],
  ["bun scripts/x.mjs", false],
  ["bun x vitest", false],
  ["bun --cwd /w scripts/x.mjs -e foo", false],
  ["bun --env-file .env scripts/x.mjs", false],
  ["perl -e 'x'", false],
  ["ruby -e 'x'", false],
  ["deno eval 'x'", false],
];

test("inline interpreter verdict table", () => {
  for (const [command, expected] of CASES) {
    assert.equal(commandContainsInlineInterpreter(command), expected, command);
  }
});
