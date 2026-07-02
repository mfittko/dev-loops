import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSettings } from "../../scripts/projects/_resolve-project.mjs";

function withTempDevloops(contents, ext, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "resolve-project-"));
  try {
    if (contents !== null) writeFileSync(path.join(dir, `.devloops${ext}`), contents, "utf-8");
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("_resolve-project — resolveSettings", () => {
  it("returns null when no .devloops file is present", () => {
    withTempDevloops(null, "", (dir) => {
      assert.strictEqual(resolveSettings(dir), null);
    });
  });

  it("prefers projectNumber over boardTitle", () => {
    withTempDevloops("queue:\n  projectNumber: 5\n  boardTitle: \"ignored\"\n", "", (dir) => {
      const s = resolveSettings(dir);
      assert.strictEqual(s.project, 5);
      assert.strictEqual(s.title, undefined);
    });
  });

  it("returns { title } when only boardTitle is set", () => {
    withTempDevloops("queue:\n  boardTitle: \"  Dev Loop Queue  \"\n", "", (dir) => {
      const s = resolveSettings(dir);
      assert.strictEqual(s.title, "Dev Loop Queue");
      assert.strictEqual(s.project, undefined);
    });
  });

  it("returns {} (no project/title) when queue present but neither field set", () => {
    withTempDevloops("queue:\n  archiveOlderThanDays: 3\n", "", (dir) => {
      const s = resolveSettings(dir);
      assert.strictEqual(s.project, undefined);
      assert.strictEqual(s.title, undefined);
      assert.strictEqual(s.olderThanDays, 3);
    });
  });

  it("returns null when queue key is absent entirely", () => {
    withTempDevloops("other: 1\n", "", (dir) => {
      assert.strictEqual(resolveSettings(dir), null);
    });
  });

  it("ignores a non-positive projectNumber and falls through to boardTitle", () => {
    withTempDevloops("queue:\n  projectNumber: 0\n  boardTitle: \"B\"\n", "", (dir) => {
      const s = resolveSettings(dir);
      assert.strictEqual(s.project, undefined);
      assert.strictEqual(s.title, "B");
    });
  });

  it("reads a .json variant", () => {
    withTempDevloops(JSON.stringify({ queue: { projectNumber: 7 } }), ".json", (dir) => {
      const s = resolveSettings(dir);
      assert.strictEqual(s.project, 7);
    });
  });

  it("returns null (does not throw) on a syntactically broken .devloops", () => {
    withTempDevloops("queue:\n  projectNumber: : : bad\n", "", (dir) => {
      assert.strictEqual(resolveSettings(dir), null);
    });
  });

  it("ignores a float projectNumber (fail-closed) with no boardTitle", () => {
    withTempDevloops("queue:\n  projectNumber: 5.5\n", "", (dir) => {
      const s = resolveSettings(dir);
      assert.strictEqual(s.project, undefined);
      assert.strictEqual(s.title, undefined);
    });
  });

  it("ignores a quoted-string projectNumber (fail-closed) with no boardTitle", () => {
    withTempDevloops("queue:\n  projectNumber: \"5\"\n", "", (dir) => {
      const s = resolveSettings(dir);
      assert.strictEqual(s.project, undefined);
      assert.strictEqual(s.title, undefined);
    });
  });
});
