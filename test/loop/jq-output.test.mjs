import assert from "node:assert/strict";
import test from "node:test";
import {
  JqFilterError,
  evaluateJqFilter,
  emitResult,
} from "../../scripts/lib/jq-output.mjs";

function sink() {
  let buf = "";
  return { write: (t) => { buf += t; }, get: () => buf };
}

const sample = {
  ok: true,
  ciStatus: "success",
  snapshot: { rounds: 3, nested: { deep: "v" } },
  items: [{ n: 1 }, { n: 2 }, { n: 3 }],
  newComments: [{ body: "a" }, { body: "b" }],
};

test("evaluateJqFilter: identity, field, chain, index, iterate, pipe", () => {
  assert.deepEqual(evaluateJqFilter(sample, "."), [sample]);
  assert.deepEqual(evaluateJqFilter(sample, ".ciStatus"), ["success"]);
  assert.deepEqual(evaluateJqFilter(sample, ".snapshot.nested.deep"), ["v"]);
  assert.deepEqual(evaluateJqFilter(sample, ".items[1].n"), [2]);
  assert.deepEqual(evaluateJqFilter(sample, ".items[]"), sample.items);
  assert.deepEqual(evaluateJqFilter(sample, ".newComments[] | .body"), ["a", "b"]);
  assert.deepEqual(evaluateJqFilter(sample, ".items | length"), [3]);
  assert.deepEqual(evaluateJqFilter(sample, ".snapshot | keys"), [["nested", "rounds"]]);
});

test("evaluateJqFilter: comparison and select", () => {
  assert.deepEqual(evaluateJqFilter(sample, '.ciStatus=="success"'), [true]);
  assert.deepEqual(evaluateJqFilter(sample, '.ciStatus=="failure"'), [false]);
  assert.deepEqual(evaluateJqFilter(sample, ".items[] | select(.n>1) | .n"), [2, 3]);
});

test("evaluateJqFilter: fails closed on unsupported syntax", () => {
  assert.throws(() => evaluateJqFilter(sample, "ciStatus"), JqFilterError);
  assert.throws(() => evaluateJqFilter(sample, ".items | bogusfn"), JqFilterError);
  assert.throws(() => evaluateJqFilter(sample, ""), JqFilterError);
  assert.doesNotThrow(() => evaluateJqFilter(sample, ".")); // identity is valid
});

test("emitResult: no jq/silent prints verbatim JSON, exit follows ok", () => {
  const out = sink();
  assert.equal(emitResult(sample, { stdout: out }), 0);
  assert.deepEqual(JSON.parse(out.get()), sample);
  const out2 = sink();
  assert.equal(emitResult({ ok: false, error: "x" }, { stdout: out2 }), 1);
});

test("emitResult: --jq prints filtered value", () => {
  const out = sink();
  assert.equal(emitResult(sample, { jq: ".ciStatus", stdout: out }), 0);
  assert.equal(out.get().trim(), "success");
});

test("emitResult: --silent pass exits 0 with no stdout", () => {
  const out = sink();
  assert.equal(emitResult(sample, { silent: true, stdout: out }), 0);
  assert.equal(out.get(), "");
});

test("emitResult: --silent fail exits 1 with no stdout", () => {
  const out = sink();
  assert.equal(emitResult({ ok: false }, { silent: true, stdout: out }), 1);
  assert.equal(out.get(), "");
});

test("emitResult: --jq predicate + --silent maps truthy/falsy to exit code silently", () => {
  const out = sink();
  assert.equal(emitResult(sample, { jq: '.ciStatus=="success"', silent: true, stdout: out }), 0);
  assert.equal(out.get(), "");
  const out2 = sink();
  assert.equal(emitResult(sample, { jq: '.ciStatus=="failure"', silent: true, stdout: out2 }), 1);
  assert.equal(out2.get(), "");
});

test("emitResult: invalid --jq fails closed (exit 2 + stderr), distinct from predicate-false", () => {
  const out = sink();
  const err = sink();
  assert.equal(emitResult(sample, { jq: "bogus", silent: true, stdout: out, stderr: err }), 2);
  assert.equal(out.get(), "");
  assert.match(err.get(), /--jq/);
});
