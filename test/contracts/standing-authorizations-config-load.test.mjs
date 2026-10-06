import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadDevLoopConfig } from "../../packages/core/src/config/config.mjs";

// A malformed standing record is judged (and refused) by the waiver writer; it
// must never drop the rest of the .devloops layer.
for (const [label, record] of [["null", ""], ["string", " nope"], ["list", "\n    - a"]]) {
  test(`a ${label} standingAuthorizations.adrTripwireWaiver still loads the layer`, async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-standing-cfg-"));
    try {
      await writeFile(path.join(repoRoot, ".devloops"), `version: 1\nstandingAuthorizations:\n  adrTripwireWaiver:${record}\n`);
      const { errors } = await loadDevLoopConfig({ repoRoot });
      assert.deepEqual(errors, []);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
}
