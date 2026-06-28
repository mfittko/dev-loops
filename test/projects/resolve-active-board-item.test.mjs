import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collapseToTarget } from "../../scripts/projects/resolve-active-board-item.mjs";

describe("resolve-active-board-item collapseToTarget (#988)", () => {
  it("exactly one issue item -> that issue target", () => {
    const r = collapseToTarget([{ issueNumber: 42, prNumber: null, title: "Do thing" }]);
    assert.deepEqual(r, { ok: true, target: { kind: "issue", number: 42 } });
  });

  it("exactly one item with a linked PR -> prefers the PR target", () => {
    const r = collapseToTarget([{ issueNumber: 42, prNumber: 99, title: "Do thing" }]);
    assert.deepEqual(r, { ok: true, target: { kind: "pr", number: 99 } });
  });

  it("zero items -> fail closed asking for explicit #N", () => {
    const r = collapseToTarget([]);
    assert.equal(r.ok, false);
    assert.match(r.reason, /No in-progress board item/);
    assert.match(r.reason, /\/continue #N/);
    assert.equal(r.target, undefined);
  });

  it("multiple items -> fail closed naming the items", () => {
    const r = collapseToTarget([
      { issueNumber: 42, prNumber: null, title: "First" },
      { issueNumber: null, prNumber: 7, title: "Second" },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.reason, /2 in-progress board items/);
    assert.match(r.reason, /issue #42 \(First\)/);
    assert.match(r.reason, /PR #7 \(Second\)/);
    assert.match(r.reason, /disambiguate/);
  });
});
