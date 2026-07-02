import assert from "node:assert/strict";
import test from "node:test";

import { buildLabelArgs } from "../../scripts/github/create-label.mjs";

test("buildLabelArgs includes name, repo and default color", () => {
  const args = buildLabelArgs({ repo: "o/n", name: "gate:full", color: "d73a4a" });
  assert.deepEqual(args, ["label", "create", "gate:full", "--repo", "o/n", "--color", "d73a4a"]);
});

test("buildLabelArgs respects a color override", () => {
  const args = buildLabelArgs({ repo: "o/n", name: "x", color: "00ff00" });
  assert.equal(args[args.indexOf("--color") + 1], "00ff00");
});

test("buildLabelArgs appends --description when provided, omits when not", () => {
  const withDesc = buildLabelArgs({ repo: "o/n", name: "x", color: "d73a4a", description: "hi" });
  assert.equal(withDesc.includes("--description"), true);
  assert.equal(withDesc[withDesc.indexOf("--description") + 1], "hi");

  const withoutDesc = buildLabelArgs({ repo: "o/n", name: "x", color: "d73a4a" });
  assert.equal(withoutDesc.includes("--description"), false);
});

test("buildLabelArgs appends --force only when force is true", () => {
  const forced = buildLabelArgs({ repo: "o/n", name: "x", color: "d73a4a", force: true });
  assert.equal(forced.includes("--force"), true);

  const unforced = buildLabelArgs({ repo: "o/n", name: "x", color: "d73a4a", force: false });
  assert.equal(unforced.includes("--force"), false);
});
