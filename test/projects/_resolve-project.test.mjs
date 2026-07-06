import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveSettings,
  parseProjectRef,
  parseItemRef,
  resolveProjectSelector,
  findProject,
} from "../../scripts/projects/_resolve-project.mjs";

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

describe("_resolve-project — parseProjectRef", () => {
  it("parses a positive integer as a number ref", () => {
    assert.deepStrictEqual(parseProjectRef("42"), { kind: "number", value: 42 });
  });

  it("parses a node ID as an id ref", () => {
    assert.deepStrictEqual(parseProjectRef("PVT_abc123"), { kind: "id", value: "PVT_abc123" });
  });

  it("parses a user-scoped board URI", () => {
    assert.deepStrictEqual(
      parseProjectRef("https://github.com/users/mfittko/projects/3"),
      { kind: "uri", number: 3, owner: "mfittko", ownerKind: "user" },
    );
  });

  it("parses an org-scoped board URI", () => {
    assert.deepStrictEqual(
      parseProjectRef("https://github.com/orgs/myorg/projects/7"),
      { kind: "uri", number: 7, owner: "myorg", ownerKind: "org" },
    );
  });

  it("parses a board URI with leading/trailing whitespace", () => {
    assert.deepStrictEqual(
      parseProjectRef("  https://github.com/users/alice/projects/1  "),
      { kind: "uri", number: 1, owner: "alice", ownerKind: "user" },
    );
  });

  it("throws INVALID_PROJECT for empty/malformed input", () => {
    for (const bad of ["", "   ", "0", "not/a/ref"]) {
      assert.throws(() => parseProjectRef(bad), (err) => err.code === "INVALID_PROJECT");
    }
  });

  it("throws INVALID_PROJECT for a board URI with project number 0", () => {
    assert.throws(
      () => parseProjectRef("https://github.com/users/mfittko/projects/0"),
      (err) => err.code === "INVALID_PROJECT",
    );
  });

  it("throws INVALID_PROJECT for an https URL that is not a Projects V2 board URI", () => {
    assert.throws(
      () => parseProjectRef("https://github.com/users/mfittko/repos/dev-loops"),
      (err) => err.code === "INVALID_PROJECT",
    );
  });

  it("parses a node ID whose payload contains a hyphen (#1227)", () => {
    assert.deepStrictEqual(
      parseProjectRef("PVT_lAHOAAT8js4BaBePzgxz5-I"),
      { kind: "id", value: "PVT_lAHOAAT8js4BaBePzgxz5-I" },
    );
  });
});

describe("_resolve-project — parseItemRef", () => {
  it("parses a positive integer as a number ref", () => {
    assert.deepStrictEqual(parseItemRef("10"), { kind: "number", value: 10 });
  });

  it("parses a node ID as an id ref", () => {
    assert.deepStrictEqual(parseItemRef("PVTI_42"), { kind: "id", value: "PVTI_42" });
  });

  // Regression (#1227): the exact live ID that reconcile-queue passed and
  // move-queue-item's validator rejected — its base64url payload has a hyphen.
  it("parses a node ID whose payload contains a hyphen", () => {
    const hyphenId = "PVTI_lAHOAAT8js4BaBePzgxz5-I";
    assert.deepStrictEqual(parseItemRef(hyphenId), { kind: "id", value: hyphenId });
  });

  it("throws INVALID_ITEM for empty/malformed input", () => {
    for (const bad of ["", "   ", "0", "not-a-number", "not/a/ref"]) {
      assert.throws(() => parseItemRef(bad), (err) => err.code === "INVALID_ITEM");
    }
  });
});

describe("_resolve-project — resolveProjectSelector", () => {
  it("explicit --project ref wins over projectTitle", () => {
    const sel = resolveProjectSelector({ project: "42", projectTitle: "ignored" });
    assert.deepStrictEqual(sel.projectRef, { kind: "number", value: 42 });
    assert.strictEqual(sel.projectTitle, null);
  });

  it("resolves by title when only projectTitle is set", () => {
    const sel = resolveProjectSelector({ projectTitle: "  My Board  " });
    assert.strictEqual(sel.projectRef, null);
    assert.strictEqual(sel.projectTitle, "My Board");
  });

  it("resolves a board URI ref and exposes owner+kind", () => {
    const sel = resolveProjectSelector({ project: "https://github.com/users/mfittko/projects/3" });
    assert.deepStrictEqual(sel.projectRef, { kind: "uri", number: 3, owner: "mfittko", ownerKind: "user" });
    assert.strictEqual(sel.projectTitle, null);
  });

  it("throws INVALID_PROJECT when neither is present", () => {
    assert.throws(() => resolveProjectSelector({}), (err) => err.code === "INVALID_PROJECT");
  });
});

describe("_resolve-project — findProject", () => {
  const projects = [
    { id: "PVT_x", number: 1, title: "Alpha" },
    { id: "PVT_y", number: 2, title: "Beta" },
  ];

  it("finds by node id", () => {
    const p = findProject(projects, { projectRef: { kind: "id", value: "PVT_y" }, projectTitle: null }, "owner");
    assert.strictEqual(p.number, 2);
  });

  it("finds by number", () => {
    const p = findProject(projects, { projectRef: { kind: "number", value: 1 }, projectTitle: null }, "owner");
    assert.strictEqual(p.id, "PVT_x");
  });

  it("finds by URI number", () => {
    const p = findProject(projects, { projectRef: { kind: "uri", number: 2, owner: "mfittko", ownerKind: "user" }, projectTitle: null }, "mfittko");
    assert.strictEqual(p.id, "PVT_y");
  });

  it("finds by title", () => {
    const p = findProject(projects, { projectRef: null, projectTitle: "Beta" }, "owner");
    assert.strictEqual(p.number, 2);
  });

  it("throws PROJECT_NOT_FOUND with an id desc", () => {
    assert.throws(
      () => findProject(projects, { projectRef: { kind: "id", value: "PVT_missing" }, projectTitle: null }, "owner"),
      (err) => err.code === "PROJECT_NOT_FOUND" && /"PVT_missing" not found under owner "owner"/.test(err.message),
    );
  });

  it("throws PROJECT_NOT_FOUND with a number desc", () => {
    assert.throws(
      () => findProject(projects, { projectRef: { kind: "number", value: 99 }, projectTitle: null }, "owner"),
      (err) => err.code === "PROJECT_NOT_FOUND" && /number 99 not found under owner "owner"/.test(err.message),
    );
  });

  it("throws PROJECT_NOT_FOUND with a URI desc", () => {
    assert.throws(
      () => findProject(projects, { projectRef: { kind: "uri", number: 99, owner: "mfittko", ownerKind: "user" }, projectTitle: null }, "mfittko"),
      (err) => err.code === "PROJECT_NOT_FOUND" && /URI number 99 under "mfittko"/.test(err.message),
    );
  });

  it("throws PROJECT_NOT_FOUND with a title desc", () => {
    assert.throws(
      () => findProject(projects, { projectRef: null, projectTitle: "Gamma" }, "owner"),
      (err) => err.code === "PROJECT_NOT_FOUND" && /title "Gamma" not found under owner "owner"/.test(err.message),
    );
  });
});
