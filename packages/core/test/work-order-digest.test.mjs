import assert from "node:assert/strict";
import { test } from "bun:test";
import * as policy from "../src/loop/work-order-digest.mjs";
import { sha256Hex } from "../src/loop/review-dispatch-plan.mjs";

const digest = (value) => sha256Hex(value).slice(7);
const baseline = "a".repeat(40);
function fixture() {
  const actList = JSON.parse('[{"sha256":"/absolute/file","bytes":7,"outputRefs":["/tmp/a","relative"],"nested":{"__proto__":{"promptPath":"/local"}}}]');
  const delta = { reviewBaselineHead: baseline, nested: { prefixSha256: "retained" } };
  const requiredReads = [actList, delta].map((value, index) => {
    const bytes = Buffer.from(JSON.stringify(value));
    return { kind: index ? "delta-result" : "act-list", required: true, bytes: bytes.length, sha256: digest(bytes) };
  });
  return { order: { role: "fixer", phase: "full", source: "act-list", headSha: "b".repeat(40), requiredReads,
    authority: { reviewBaselineHead: baseline, sourceDigest: digest(actList), deltaResultDigest: digest(delta) } },
  bytes: new Map(requiredReads.map((read, index) => [read, Buffer.from(JSON.stringify(index ? delta : actList))])), actList, delta };
}

test("review baseline policy is exported and absence reads no authority material", () => {
  assert.equal(typeof policy.assertFixerReviewBaseline, "function");
  assert.equal(policy.assertFixerReviewBaseline({ authority: {}, get requiredReads() { throw new Error("must not read"); } }, null), null);
});

test("review baseline authenticates complete JSON using the producer/verifier content digest", () => {
  const { order, bytes, actList, delta } = fixture();
  assert.deepEqual(policy.assertFixerReviewBaseline(order, bytes), { reviewBaselineHead: baseline, actList, delta });
  const reordered = Buffer.from(JSON.stringify([{ nested: actList[0].nested, outputRefs: actList[0].outputRefs, bytes: 7, sha256: "/absolute/file" }]));
  bytes.set(order.requiredReads[0], reordered);
  Object.assign(order.requiredReads[0], { bytes: reordered.length, sha256: digest(reordered) });
  assert.deepEqual(policy.assertFixerReviewBaseline(order, bytes).actList, actList);
  const before = policy.workOrderDigest(order);
  order.authority.reviewBaselineHead = "c".repeat(40);
  assert.notEqual(policy.workOrderDigest(order), before);
  for (const mutate of [
    (value) => { value[0].bytes++; }, (value) => { value[0].sha256 = "/another/file"; },
    (value) => { value[0].outputRefs.reverse(); }, (value) => { value[0].nested.__proto__.promptPath = "/other"; },
  ]) {
    const f = fixture();
    mutate(f.actList);
    const read = f.order.requiredReads[0];
    const changed = Buffer.from(JSON.stringify(f.actList));
    Object.assign(read, { bytes: changed.length, sha256: digest(changed) });
    f.bytes.set(read, changed);
    assert.throws(() => policy.assertFixerReviewBaseline(f.order, f.bytes), /review baseline/);
  }
});

for (const defect of ["null", "empty", "undefined", "uppercase", "short", "64", "role", "phase", "source", "missing", "duplicate", "optional", "buffer", "length", "hash", "json", "sourceDigest", "deltaResultDigest", "baseline"]) test(`review baseline refuses ${defect}`, () => {
  const { order, bytes } = fixture();
  const read = order.requiredReads[defect === "sourceDigest" ? 0 : 1];
  if (["null", "empty", "undefined", "uppercase", "short", "64"].includes(defect)) order.authority.reviewBaselineHead = ({ null: null, empty: "", undefined: undefined, uppercase: "A".repeat(40), short: "a", 64: "a".repeat(64) })[defect];
  if (["role", "phase", "source"].includes(defect)) order[defect] = "other";
  if (defect === "missing") order.requiredReads.pop();
  if (defect === "duplicate") order.requiredReads.push({ ...read });
  if (defect === "optional") read.required = false;
  if (defect === "buffer") bytes.delete(read);
  if (defect === "length") read.bytes++;
  if (defect === "hash") read.sha256 = "0".repeat(64);
  if (["sourceDigest", "deltaResultDigest"].includes(defect)) delete order.authority[defect];
  if (["json", "baseline"].includes(defect)) {
    const changed = Buffer.from(defect === "json" ? "{" : JSON.stringify({ reviewBaselineHead: "c".repeat(40) }));
    bytes.set(read, changed);
    Object.assign(read, { bytes: changed.length, sha256: digest(changed) });
    if (defect === "baseline") order.authority.deltaResultDigest = digest(JSON.parse(changed));
  }
  assert.throws(() => policy.assertFixerReviewBaseline(order, bytes), /review baseline/);
});

for (const kind of ["act-list", "delta-result"]) for (const defect of ["missing", "duplicate", "optional", "length", "hash", "semantic", "entryIdentity"]) test(`review baseline authenticates ${kind} ${defect}`, () => {
  const f = fixture();
  const read = f.order.requiredReads.find((entry) => entry.kind === kind);
  if (defect === "missing") f.order.requiredReads = f.order.requiredReads.filter((entry) => entry !== read);
  if (defect === "duplicate") f.order.requiredReads.push({ ...read });
  if (defect === "optional") read.required = false;
  if (defect === "length") read.bytes = String(read.bytes);
  if (defect === "hash") read.sha256 = `sha256:${read.sha256}`;
  if (defect === "semantic") f.order.authority[kind === "act-list" ? "sourceDigest" : "deltaResultDigest"] = "0".repeat(64);
  if (defect === "entryIdentity") { f.bytes.set({ ...read }, f.bytes.get(read)); f.bytes.delete(read); }
  assert.throws(() => policy.assertFixerReviewBaseline(f.order, f.bytes), /review baseline/);
});
