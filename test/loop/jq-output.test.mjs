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
  // Root index access `.[N]` (and `.[N].field`) against an array value.
  assert.deepEqual(evaluateJqFilter([10, 20, 30], ".[0]"), [10]);
  assert.deepEqual(evaluateJqFilter([{ n: 1 }, { n: 2 }], ".[1].n"), [2]);
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

test("evaluateJqFilter: ordered comparison is jq-faithful (no JS coercion)", () => {
  // Numeric STRING vs number literal: jq never coerces; fail closed instead.
  assert.throws(() => evaluateJqFilter({ s: "5" }, "select(.s > 3)"), JqFilterError);
  assert.throws(() => evaluateJqFilter({ s: "5" }, ".s > 3"), JqFilterError);
  // number-number and string-string ordered comparisons still work.
  assert.deepEqual(evaluateJqFilter({ n: 5 }, ".n > 3"), [true]);
  assert.deepEqual(evaluateJqFilter({ n: 2 }, ".n > 3"), [false]);
  assert.deepEqual(evaluateJqFilter({ s: "b" }, '.s > "a"'), [true]);
  assert.deepEqual(evaluateJqFilter(sample, ".items[] | select(.n > 1) | .n"), [2, 3]);
});

test("evaluateJqFilter: missing path equals null (jq-faithful)", () => {
  assert.deepEqual(evaluateJqFilter(sample, ".missing == null"), [true]);
  assert.deepEqual(evaluateJqFilter(sample, ".ciStatus == null"), [false]);
  assert.deepEqual(evaluateJqFilter(sample, ".missing != null"), [false]);
  // Chain over a missing path resolves to null, doesn't crash.
  assert.deepEqual(evaluateJqFilter(sample, ".missing.a.b == null"), [true]);
});

test("evaluateJqFilter: fails closed on unsupported syntax", () => {
  assert.throws(() => evaluateJqFilter(sample, "ciStatus"), JqFilterError);
  assert.throws(() => evaluateJqFilter(sample, ".items | bogusfn"), JqFilterError);
  assert.throws(() => evaluateJqFilter(sample, ""), JqFilterError);
  assert.doesNotThrow(() => evaluateJqFilter(sample, ".")); // identity is valid
});

test("evaluateJqFilter: empty predicate / empty LHS fails closed (not identity)", () => {
  assert.throws(() => evaluateJqFilter(sample, "select()"), JqFilterError);
  assert.throws(() => evaluateJqFilter(sample, '== "x"'), JqFilterError);
  assert.throws(() => evaluateJqFilter(sample, "select( == 1)"), JqFilterError);
});

test("evaluateJqFilter: operators inside quoted RHS literals parse correctly", () => {
  assert.deepEqual(evaluateJqFilter({ title: "a>b" }, '.title=="a>b"'), [true]);
  assert.deepEqual(evaluateJqFilter({ title: "a==b" }, '.title=="a==b"'), [true]);
  assert.deepEqual(evaluateJqFilter({ name: "<svg>" }, '.name=="<svg>"'), [true]);
  assert.deepEqual(evaluateJqFilter({ title: "a>b" }, 'select(.title=="a>b")'), [{ title: "a>b" }]);
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

test("emitResult: --silent multi-value uses last output (jq -e semantics)", () => {
  // [false,true,true] -> jq -e exits 0 on the last value being truthy.
  const out = sink();
  assert.equal(emitResult(sample, { jq: ".items[] | .n>1", silent: true, stdout: out }), 0);
  assert.equal(out.get(), "");
  // [true,false] -> last value false -> exit 1.
  const out2 = sink();
  assert.equal(emitResult({ xs: [{ n: 5 }, { n: 1 }] }, { jq: ".xs[] | .n>1", silent: true, stdout: out2 }), 1);
  // Empty output -> falsy.
  const out3 = sink();
  assert.equal(emitResult({ xs: [] }, { jq: ".xs[]", silent: true, stdout: out3 }), 1);
});

test("emitResult: invalid --jq fails closed (exit 2 + stderr), distinct from predicate-false", () => {
  const out = sink();
  const err = sink();
  assert.equal(emitResult(sample, { jq: "bogus", silent: true, stdout: out, stderr: err }), 2);
  assert.equal(out.get(), "");
  assert.match(err.get(), /--jq/);
});
