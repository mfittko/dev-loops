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
