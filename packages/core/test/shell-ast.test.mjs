import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";

import { decideBashGateDeny } from "../src/loop/bash-gate-decisions.mjs";
import { parseShell, shellOperators, walkShell } from "../src/loop/shell-ast.mjs";

// ADR 0276: `sh-syntax/sync` behind a lazy adapter. Importing the classifier loads no wasm.

const loop = (name) => fileURLToPath(new URL(`../src/loop/${name}`, import.meta.url));

test("importing bash-command-classify and running a non-parsing predicate loads no sh-syntax module; the first parse loads it", () => {
  // a fresh process: the test runner may already have parsed in this one
  const probe = `
    import { createRequire } from "node:module";
    const classify = await import(${JSON.stringify(loop("bash-command-classify.mjs"))});
    const shell = await import(${JSON.stringify(loop("shell-ast.mjs"))});
    const cache = createRequire(${JSON.stringify(loop("x.mjs"))}).cache;
    const loaded = () => Object.keys(cache).some((key) => key.includes("sh-syntax"));
    classify.commandContainsGhPrReady("gh pr ready 5");
    const before = loaded();
    shell.parseShell("ls");
    console.log(JSON.stringify({ before, after: loaded() }));
  `;
  const run = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { before: false, after: true });
});

test("parseShell returns a tree for the smoke-test shapes and { error } for an unclosed quote (comment 6897868251)", () => {
  const shapes = [
    "cat <<'EOF'\nnode x &\nEOF",
    "bash <<< \"a b\"'; node -e y'",
    "bash -c -e 'x; node -e y'",
    "echo $'a\\'b; node -e y'",
    "git commit -m \"$(cat <<'E'\nbody\nE\n)\"",
    "echo a # it's",
    "echo a >| tmp/f",
    "python3 -I - <<'E'\nprint(1)\nE",
    "(echo a; echo b) | while read x; do echo $x; done",
    "for p in a b; do echo $p; done",
  ];
  for (const shape of shapes) {
    const parsed = parseShell(shape);
    assert.ok(parsed.file?.stmts.length > 0, shape);
    assert.equal(parsed.error, undefined, shape);
  }
  const bad = parseShell("node -e 'x");
  assert.equal(bad.file, undefined);
  assert.match(bad.error.message, /closing quote/);
});

test("parseShell rethrows an error that is not a ParseError", () => {
  assert.throws(() => parseShell(undefined));
});

test("the walk reaches the simple commands of every nested construct (Q3)", () => {
  const heads = (text) => {
    const found = [];
    walkShell(parseShell(text).file, (node) => { if (node.type === "CallExpr") found.push(node.args[0]?.parts[0]?.value); });
    return found;
  };
  assert.deepEqual(heads("echo \"$(a)\" `b` <(c)"), ["echo", "a", "b", "c"]);
  assert.deepEqual(heads("f() { d; }; case x in x) e;; esac; coproc g"), ["d", "e", "g"]);
  assert.deepEqual(heads("cat <<EOF\n$(h)\nEOF"), ["cat", "h"]);
  assert.deepEqual(heads("cat <<'EOF'\n$(h)\nEOF"), ["cat"]); // a quoted-delimiter body is text
  assert.equal(typeof shellOperators().redir.Hdoc, "number");
});

test("decideBashGateDeny stays synchronous: it returns a plain object, not a Promise", () => {
  const facts = { command: "node -e 'x'", role: null, repoSlug: "mfittko/dev-loops", managedRepoSlug: "mfittko/dev-loops", inManagedContext: true, humanMergeOnly: false, enforceCoordinator: false };
  const decision = decideBashGateDeny(facts);
  assert.ok(!(decision instanceof Promise));
  assert.equal(typeof decision.then, "undefined");
  assert.equal(decision.ruleId, "OPS-NO-INLINE-INTERPRETER");
  assert.equal(decideBashGateDeny({ ...facts, command: "ls" }), null);
});
