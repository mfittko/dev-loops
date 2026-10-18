import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { findActiveSequence, writeSequenceMarker } from "@dev-loops/core/loop/fix-push-authority";

const seams = (baselines) => ({ listBaselines: () => baselines, isAncestor: () => true, remoteAdvanced: () => false });

test("a non-granted marker wins over a granted one when both are active", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "find-active-sequence-"));
  writeSequenceMarker({ tmpRoot, baselineHead: "aaa1", fullGranted: true });
  writeSequenceMarker({ tmpRoot, baselineHead: "bbb2", fullGranted: false });
  const found = findActiveSequence({ tmpRoot, head: "ccc3", ...seams(["aaa1", "bbb2"]) });
  assert.equal(found.baselineHead, "bbb2");
  assert.equal(found.fullGranted, false);
});

test("a malformed marker file reads as active and not granted", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "find-active-sequence-"));
  const file = writeSequenceMarker({ tmpRoot, baselineHead: "aaa1", fullGranted: true });
  fs.writeFileSync(file, "{not json");
  const found = findActiveSequence({ tmpRoot, head: "aaa1", ...seams(["aaa1"]) });
  assert.equal(found.fullGranted, false);
});

test("an unreadable marker (not ENOENT) reads as active and not granted", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "find-active-sequence-"));
  const file = writeSequenceMarker({ tmpRoot, baselineHead: "aaa1", fullGranted: true });
  fs.rmSync(file);
  fs.mkdirSync(file);
  const found = findActiveSequence({ tmpRoot, head: "aaa1", ...seams(["aaa1"]) });
  assert.equal(found.fullGranted, false);
});

const throwing = (baselines) => ({ listBaselines: () => baselines, isAncestor: () => { throw new Error("missing object"); }, remoteAdvanced: () => false });

test("a granted marker whose baseline object is missing is skipped (push admitted)", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "find-active-sequence-"));
  writeSequenceMarker({ tmpRoot, baselineHead: "aaa1", fullGranted: true, branch: "issue-9" });
  assert.equal(findActiveSequence({ tmpRoot, head: "ccc3", ...throwing(["aaa1"]) }), null);
});

test("a granted marker covering the head with the branch not advanced is admitted", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "find-active-sequence-"));
  writeSequenceMarker({ tmpRoot, baselineHead: "aaa1", fullGranted: true, branch: "issue-9" });
  assert.equal(findActiveSequence({ tmpRoot, head: "aaa1", ...seams(["aaa1"]) }).fullGranted, true);
});

test("an ungranted marker whose baseline object is missing still refuses", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "find-active-sequence-"));
  writeSequenceMarker({ tmpRoot, baselineHead: "aaa1", fullGranted: false, branch: "issue-9" });
  const found = findActiveSequence({ tmpRoot, head: "ccc3", ...throwing(["aaa1"]) });
  assert.equal(found.baselineHead, "aaa1");
  assert.equal(found.fullGranted, false);
});

test("stacked branches: each push is covered only by its own branch marker", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "find-active-sequence-"));
  writeSequenceMarker({ tmpRoot, baselineHead: "aaa1", fullGranted: false, branch: "issue-a" });
  writeSequenceMarker({ tmpRoot, baselineHead: "bbb2", fullGranted: true, branch: "issue-b" });
  // isAncestor is always true: B descends from A's baseline.
  const find = (head, remoteRef, baselines) => findActiveSequence({ tmpRoot, head, remoteRef, ...seams(baselines) });
  assert.equal(find("ccc3", "refs/heads/issue-a", ["aaa1"]).branch, "issue-a");
  assert.equal(find("ccc3", "refs/heads/issue-b", ["bbb2"]).branch, "issue-b");
  assert.equal(find("ccc3", "refs/heads/issue-b", ["aaa1"]), null);
  assert.equal(find("ccc3", "refs/heads/issue-a", ["bbb2"]), null);
  // Both markers listed together: the real stacked push.
  assert.equal(find("ccc3", "refs/heads/issue-b", ["aaa1", "bbb2"]).branch, "issue-b");
  assert.equal(find("ccc3", "refs/heads/issue-b", ["aaa1", "bbb2"]).fullGranted, true);
  assert.equal(find("ccc3", "refs/heads/issue-a", ["aaa1", "bbb2"]).branch, "issue-a");
  assert.equal(find("ccc3", "refs/heads/issue-a", ["aaa1", "bbb2"]).fullGranted, false);
});

test("an ungranted marker covering the head refuses", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "find-active-sequence-"));
  writeSequenceMarker({ tmpRoot, baselineHead: "aaa1", fullGranted: false, branch: "issue-9" });
  assert.equal(findActiveSequence({ tmpRoot, head: "aaa1", ...seams(["aaa1"]) }).fullGranted, false);
});

for (const [label, branch] of [["empty", ""], ["whitespace-padded", " issue-a "], ["whitespace-only", "   "], ["inner space", "issue a"], ["double dot", "issue..a"], ["trailing .lock", "issue.lock"], ["leading dash", "-issue"], ["literal HEAD", "HEAD"]]) {
  test(`a marker with ${label} branch reads as branchless and refuses a descendant push`, () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "find-active-sequence-"));
    const file = writeSequenceMarker({ tmpRoot, baselineHead: "aaa1", fullGranted: false });
    fs.writeFileSync(file, JSON.stringify({ baselineHead: "aaa1", fullGranted: false, branch }));
    const found = findActiveSequence({ tmpRoot, head: "ccc3", remoteRef: "refs/heads/issue-a", ...seams(["aaa1"]) });
    assert.equal(found.baselineHead, "aaa1");
    assert.equal(found.branch, undefined);
  });
}

test("a marker with a trimmed non-empty branch keeps it", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "find-active-sequence-"));
  writeSequenceMarker({ tmpRoot, baselineHead: "aaa1", fullGranted: false, branch: "issue-a" });
  assert.equal(findActiveSequence({ tmpRoot, head: "ccc3", remoteRef: "refs/heads/issue-a", ...seams(["aaa1"]) }).branch, "issue-a");
});
