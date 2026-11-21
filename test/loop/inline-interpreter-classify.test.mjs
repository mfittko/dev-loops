import assert from "node:assert/strict";
import { test } from "bun:test";
import { commandContainsInlineInterpreter, inlineInterpreterVerdict } from "@dev-loops/core/loop/bash-command-classify";
import { decideBashGate } from "@dev-loops/core/claude/hook-decisions";
import { INLINE_INTERPRETER_FORMS, INLINE_INTERPRETER_VERDICT_CASES } from "../fixtures/inline-interpreter-forms.mjs";
import * as main from "../fixtures/bash-command-classify.origin-main.mjs";

// OPS-NO-INLINE-INTERPRETER verdict table (#2442), shared with the differential corpus.
// A `-` stdin script with no heredoc, a pipe into an interpreter and a heredoc body are ceiling cases (allowed).
test("inline interpreter verdict table", () => {
  for (const [command, expected] of INLINE_INTERPRETER_VERDICT_CASES) {
    assert.equal(commandContainsInlineInterpreter(command), expected, command);
  }
});

test("every verdict-table row origin/main denied and the head allows is a fixture ceiling row (#2442 decision 2)", () => {
  const ceilings = new Set(INLINE_INTERPRETER_FORMS.filter((row) => row.ceiling).map((row) => row.command));
  let qualifying = 0;
  for (const [command, expected] of INLINE_INTERPRETER_VERDICT_CASES) {
    if (expected || !main.commandContainsInlineInterpreter(command)) continue;
    qualifying++;
    assert.ok(ceilings.has(command), command);
    assert.equal(inlineInterpreterVerdict(command), "ceiling", command);
  }
  assert.ok(qualifying > 0, "no verdict-table row qualified");
});

test("a deeply nested eval substitution returns within a fixed bound", () => {
  const depth = 30;
  const command = `gh pr merge 5 --admin; ${'eval "$('.repeat(depth)}echo x${')"'.repeat(depth)}`;
  commandContainsInlineInterpreter("true"); // warm the parser: a solo run compiles main.wasm on the first parse, outside the timed span
  const start = Date.now();
  commandContainsInlineInterpreter(command);
  inlineInterpreterVerdict(command);
  assert.ok(Date.now() - start < 2000);
});

const GATE = (command) => decideBashGate({ command, inManagedContext: true });

test("ANSI-C quoted flag values are read (#2943 slice 2)", () => {
  for (const [bin, opt, flag] of [["node", "--title", "-e"], ["python", "-W", "-c"], ["python3", "-W", "-c"], ["bun", "--cwd", "-e"]]) {
    const verdict = GATE(`${bin} ${opt} $'a\\' b' ${flag} x`);
    assert.equal(verdict.decision, "deny", bin);
    assert.match(verdict.reason, /^OPS-NO-INLINE-INTERPRETER/, bin);
  }
  assert.equal(commandContainsInlineInterpreter("node --title $'a\\' b' script.mjs"), false);
});

test("out-of-range ANSI-C code point does not throw and still denies (#3024)", () => {
  assert.equal(commandContainsInlineInterpreter(": $'\\U00110000'; node -e 1"), true);
});
