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
  ["bun run - <<EOF", true],
  ["bun run --bun - <<EOF", true],
  ["bun run --silent - <<EOF", true],
  ["bun run --smol - <<EOF", true],
  ["bun run --silent -", true],
  ["bun run --bun -", true],
  ["bun run -e 'x'", true],
  ["bun run --eval 'x'", true],
  ["bun run -p 1", true],
  ["bun run --print=1", true],
  ["bun run -", true],
  ["echo x | bun run -", true],
  ["bun --console-depth 3 -e 'x'", true],
  ["bun --inspect-wait app.ts -p 3000", false],
  ["bun run test", false],
  ["bun run verify", false],
  ["bun run x", false],
  ["bun run scripts/x.mjs -e foo", false],
  ["bun test", false],
  ["bun install", false],
  ["bun scripts/x.mjs", false],
  ["bun x vitest", false],
  ["bun --cwd /w scripts/x.mjs -e foo", false],
  ["bun --env-file .env scripts/x.mjs", false],
  ["bun --cwd '/tmp/work tree' -e 'console.log(1)'", true],
  ["bun --cwd \"/tmp/work tree\" -p 1", true],
  ["bun --preload '/tmp/a b.ts' -e 'x'", true],
  ["bun --cwd '/tmp/work tree' scripts/x.mjs -e foo", false],
  ["bun run --silent typecheck -p tsconfig.json", false],
  ["bun run --bun typecheck -p tsconfig.json", false],
  ["bun --silent typecheck -p tsconfig.json", false],
  ["perl -e 'x'", false],
  ["ruby -e 'x'", false],
  ["deno eval 'x'", false],
];

test("inline interpreter verdict table", () => {
  for (const [command, expected] of CASES) {
    assert.equal(commandContainsInlineInterpreter(command), expected, command);
  }
});
