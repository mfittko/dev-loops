import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import {
  main,
  parseCliArgs,
  parseDuration,
  selectArchivable,
  resolveSettings,
} from "../../scripts/projects/archive-done-items.mjs";

// Isolated default cwd (no .devloops): main() resolves statusColumns from cwd,
// so tests must never read THIS repo's real config as a hidden dependency —
// a future repo-level statusColumns override would silently break them.
const ISOLATED_CWD = mkdtempSync(nodePath.join(tmpdir(), "archive-done-isolated-"));
after(() => rmSync(ISOLATED_CWD, { recursive: true, force: true }));

// ── Pure unit: parseCliArgs ───────────────────────────────────────────────

describe("archive-done — parseCliArgs", () => {
  it("parses repo, project, older-than, and dry-run", () => {
    const args = parseCliArgs(["--repo", "o/r", "--project", "3", "--older-than", "7d", "--dry-run"]);
    assert.deepStrictEqual(args, { repo: "o/r", project: "3", olderThan: "7d", dryRun: true });
  });
  it("supports --help / -h", () => {
    assert.strictEqual(parseCliArgs(["--help"]).help, true);
    assert.strictEqual(parseCliArgs(["-h"]).help, true);
  });
  it("rejects an unknown flag", () => {
    assert.throws(() => parseCliArgs(["--bogus"]), (e) => e.code === "INVALID_ARGS");
  });
  it("rejects an unexpected positional", () => {
    assert.throws(() => parseCliArgs(["stray"]), (e) => e.code === "INVALID_ARGS");
  });
  it("requires a value for --repo / --project / --older-than", () => {
    assert.throws(() => parseCliArgs(["--repo"]), (e) => e.code === "INVALID_REPO");
    assert.throws(() => parseCliArgs(["--project"]), (e) => e.code === "INVALID_PROJECT");
    assert.throws(() => parseCliArgs(["--older-than"]), (e) => e.code === "INVALID_DURATION");
  });
  it("rejects an explicit inline value on boolean --dry-run", () => {
    assert.throws(() => parseCliArgs(["--dry-run=false"]), (e) => e.code === "INVALID_ARGS");
  });
});

// ── Pure unit: parseDuration ──────────────────────────────────────────────

describe("archive-done — parseDuration", () => {
  it("parses days", () => {
    assert.strictEqual(parseDuration("30d"), 30 * 24 * 60 * 60 * 1000);
  });
  it("parses hours and weeks", () => {
    assert.strictEqual(parseDuration("12h"), 12 * 60 * 60 * 1000);
    assert.strictEqual(parseDuration("2w"), 2 * 7 * 24 * 60 * 60 * 1000);
  });
  it("rejects invalid duration", () => {
    assert.throws(() => parseDuration("abc"), (e) => e.code === "INVALID_DURATION");
    assert.throws(() => parseDuration("0d"), (e) => e.code === "INVALID_DURATION");
  });
});

// ── Pure unit: selectArchivable ──────────────────────────────────────────

function item(id, { number, typename = "Issue", closed = false, closedAt = null, status = "Done" }) {
  return {
    id,
    isArchived: false,
    status,
    content: {
      __typename: typename,
      number,
      closed,
      closedAt,
      repository: { nameWithOwner: "mfittko/dev-loops" },
    },
  };
}

describe("archive-done — selectArchivable", () => {
  const now = Date.parse("2026-06-24T00:00:00Z");
  const olderThanMs = 30 * 24 * 60 * 60 * 1000;

  it("selects items closed longer than the threshold", () => {
    const items = [
      item("A", { number: 1, closed: true, closedAt: "2026-05-01T00:00:00Z" }), // 54d ago
      item("B", { number: 2, closed: true, closedAt: "2026-06-20T00:00:00Z" }), // 4d ago
    ];
    const selected = selectArchivable(items, { now, olderThanMs });
    assert.deepStrictEqual(selected.map((x) => x.id), ["A"]);
  });

  it("excludes open items even if in Done column", () => {
    const items = [
      item("C", { number: 3, closed: false, closedAt: null, status: "Done" }),
    ];
    const selected = selectArchivable(items, { now, olderThanMs });
    assert.strictEqual(selected.length, 0);
  });

  it("excludes closed items that are not in the Done column", () => {
    const items = [
      item("D", { number: 4, closed: true, closedAt: new Date(now - 40 * 86400000).toISOString(), status: "Backlog" }),
      item("E", { number: 5, closed: true, closedAt: new Date(now - 40 * 86400000).toISOString(), status: "In Progress" }),
    ];
    const selected = selectArchivable(items, { now, olderThanMs });
    assert.strictEqual(selected.length, 0);
  });
  it("excludes already-archived items", () => {
    const items = [
      { ...item("D", { number: 4, closed: true, closedAt: "2026-01-01T00:00:00Z" }), isArchived: true },
    ];
    const selected = selectArchivable(items, { now, olderThanMs });
    assert.strictEqual(selected.length, 0);
  });

  it("selects closed PRs as well as issues", () => {
    const items = [
      item("E", { number: 5, typename: "PullRequest", closed: true, closedAt: "2026-01-01T00:00:00Z" }),
    ];
    const selected = selectArchivable(items, { now, olderThanMs });
    assert.deepStrictEqual(selected.map((x) => x.id), ["E"]);
  });
});

// ── Integration via mocked gh ─────────────────────────────────────────────

function mockRunChild(responses) {
  let callIndex = 0;
  const calls = [];
  const fn = async (_cmd, args) => {
    calls.push(args);
    if (callIndex >= responses.length) {
      throw new Error("Unexpected gh call #" + (callIndex + 1));
    }
    const resp = responses[callIndex++];
    if (resp.error) return { code: 1, stdout: "", stderr: resp.error };
    return { code: 0, stdout: JSON.stringify(resp.payload), stderr: "" };
  };
  fn.calls = calls;
  return fn;
}

function userPayload() {
  return { data: { user: { id: "U_1" } } };
}
function listUserProjectsResponse(projects) {
  return { data: { user: { projectsV2: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: projects } } } };
}
const PROJECT = { id: "PVT_proj1", number: 1, title: "Dev Loop Queue", url: "u" };

function itemsResponse(nodes) {
  return { data: { node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } };
}
function rawItemNode(id, number, { closed, closedAt, status = "Done", typename = "Issue", repo = "mfittko/dev-loops" }) {
  return {
    id,
    isArchived: false,
    fieldValues: { nodes: [{ field: { id: "f", name: "Status" }, name: status }] },
    content: { __typename: typename, number, closed, closedAt, repository: { nameWithOwner: repo } },
  };
}
function archiveResponse(id) {
  return { data: { archiveProjectV2Item: { item: { id } } } };
}

function countMutations(calls) {
  return calls.filter((args) =>
    args.some((a) => typeof a === "string" && a.startsWith("query=") && a.includes("mutation")),
  ).length;
}

describe("archive-done — integration", () => {
  it("archives items closed longer than the threshold and reports them", async () => {
    const nodes = [
      rawItemNode("A", 1, { closed: true, closedAt: "2026-01-01T00:00:00Z" }),
      rawItemNode("B", 2, { closed: true, closedAt: "2026-06-23T00:00:00Z" }), // recent
    ];
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([PROJECT]) },
      { payload: itemsResponse(nodes) },
      { payload: archiveResponse("A") },
    ];
    const runChild = mockRunChild(responses);

    const result = await main(
      { repo: "mfittko/dev-loops", project: "1", olderThan: "30d", now: Date.parse("2026-06-24T00:00:00Z") },
      { runChild, cwd: ISOLATED_CWD },
    );

    assert.ok(result.ok);
    assert.strictEqual(result.archived.length, 1);
    assert.strictEqual(result.archived[0].itemId, "A");
    assert.strictEqual(result.archived[0].issueNumber, 1);
    assert.strictEqual(countMutations(runChild.calls), 1);
    // Output distinguishes all scanned board items from archive candidates.
    assert.strictEqual(result.scanned, 2);
    assert.strictEqual(result.archivable, 1);
    assert.strictEqual("considered" in result, false);
  });

  it("--dry-run lists intended archive mutations without executing", async () => {
    const nodes = [rawItemNode("A", 1, { closed: true, closedAt: "2026-01-01T00:00:00Z" })];
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([PROJECT]) },
      { payload: itemsResponse(nodes) },
    ];
    const runChild = mockRunChild(responses);

    const result = await main(
      { repo: "mfittko/dev-loops", project: "1", olderThan: "30d", dryRun: true, now: Date.parse("2026-06-24T00:00:00Z") },
      { runChild, cwd: ISOLATED_CWD },
    );

    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(result.mutations.length, 1);
    assert.ok(result.mutations[0].query.includes("archiveProjectV2Item"));
    assert.strictEqual(result.mutations[0].variables.itemId, "A");
    assert.strictEqual(countMutations(runChild.calls), 0);
    assert.strictEqual(result.scanned, 1);
    assert.strictEqual(result.archivable, 1);
  });

  it("defaults to 7d when --older-than is omitted and no config default applies", async () => {
    const nodes = [rawItemNode("A", 1, { closed: true, closedAt: "2026-06-23T00:00:00Z" })]; // 1d ago
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([PROJECT]) },
      { payload: itemsResponse(nodes) },
    ];
    const runChild = mockRunChild(responses);

    const result = await main(
      { repo: "mfittko/dev-loops", project: "1", now: Date.parse("2026-06-24T00:00:00Z") },
      { runChild, cwd: ISOLATED_CWD },
    );

    assert.ok(result.ok);
    assert.strictEqual(result.archived.length, 0);
    assert.strictEqual(result.olderThan, "7d");
  });

  it("uses olderThanDefault (from .devloops) when --older-than is omitted", async () => {
    // closedAt 5d ago: archived under a 3d config default, kept under default 7d.
    const nodes = [rawItemNode("A", 1, { closed: true, closedAt: "2026-06-19T00:00:00Z" })];
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([PROJECT]) },
      { payload: itemsResponse(nodes) },
      { payload: archiveResponse("A") },
    ];
    const runChild = mockRunChild(responses);

    const result = await main(
      { repo: "mfittko/dev-loops", project: "1", olderThanDefault: "3d", now: Date.parse("2026-06-24T00:00:00Z") },
      { runChild, cwd: ISOLATED_CWD },
    );

    assert.ok(result.ok);
    assert.strictEqual(result.olderThan, "3d");
    assert.strictEqual(result.archived.length, 1);
  });

  it("explicit --older-than overrides the config default", async () => {
    const nodes = [rawItemNode("A", 1, { closed: true, closedAt: "2026-06-19T00:00:00Z" })]; // 5d ago
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([PROJECT]) },
      { payload: itemsResponse(nodes) },
    ];
    const runChild = mockRunChild(responses);

    const result = await main(
      // explicit 7d wins over config default 3d → 5d-old item is kept
      { repo: "mfittko/dev-loops", project: "1", olderThan: "7d", olderThanDefault: "3d", now: Date.parse("2026-06-24T00:00:00Z") },
      { runChild, cwd: ISOLATED_CWD },
    );

    assert.ok(result.ok);
    assert.strictEqual(result.olderThan, "7d");
    assert.strictEqual(result.archived.length, 0);
  });

  it("resolves the board by title when --project is omitted (projectTitle)", async () => {
    const nodes = [rawItemNode("A", 1, { closed: true, closedAt: "2026-01-01T00:00:00Z" })];
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([PROJECT]) },
      { payload: itemsResponse(nodes) },
      { payload: archiveResponse("A") },
    ];
    const runChild = mockRunChild(responses);

    const result = await main(
      { repo: "mfittko/dev-loops", projectTitle: "Dev Loop Queue", olderThan: "30d", now: Date.parse("2026-06-24T00:00:00Z") },
      { runChild, cwd: ISOLATED_CWD },
    );

    assert.ok(result.ok);
    assert.strictEqual(result.archived.length, 1);
    assert.strictEqual(result.archived[0].itemId, "A");
  });

  it("fails closed when neither --project nor a configured board resolves", async () => {
    const runChild = mockRunChild([]);
    await assert.rejects(
      () => main({ repo: "mfittko/dev-loops", now: Date.parse("2026-06-24T00:00:00Z") }, { runChild, cwd: ISOLATED_CWD }),
      (e) => e.code === "INVALID_PROJECT",
    );
  });
});

// ── resolveSettings (config-driven defaults) ──────────────────────────────

function withTempDevloops(contents, fn) {
  const dir = mkdtempSync(nodePath.join(tmpdir(), "archive-done-cfg-"));
  try {
    if (contents !== null) writeFileSync(nodePath.join(dir, ".devloops"), contents, "utf-8");
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("archive-done resolves the configured done column (#1143)", () => {
  it("archives items in the overridden statusColumns.done column (\"Complete\"), not the literal \"Done\"", async () => {
    await withTempDevloops('queue:\n  projectNumber: 1\n  statusColumns:\n    done: "Complete"\n', async (cwd) => {
      const nodes = [rawItemNode("A", 1, { closed: true, closedAt: "2026-01-01T00:00:00Z", status: "Complete" })];
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([PROJECT]) },
        { payload: itemsResponse(nodes) },
        { payload: archiveResponse("A") },
      ];
      const runChild = mockRunChild(responses);

      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", olderThan: "30d", now: Date.parse("2026-06-24T00:00:00Z") },
        { runChild, cwd },
      );

      assert.ok(result.ok);
      assert.strictEqual(result.archived.length, 1);
      assert.strictEqual(result.archived[0].itemId, "A");
    });
  });

  it("does NOT archive an item still literally in \"Done\" when statusColumns.done is renamed", async () => {
    await withTempDevloops('queue:\n  projectNumber: 1\n  statusColumns:\n    done: "Complete"\n', async (cwd) => {
      // Stale item sitting in the old literal "Done" column must be left alone —
      // the configured column ("Complete") is the only one archive-done matches.
      const nodes = [rawItemNode("A", 1, { closed: true, closedAt: "2026-01-01T00:00:00Z", status: "Done" })];
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([PROJECT]) },
        { payload: itemsResponse(nodes) },
      ];
      const runChild = mockRunChild(responses);

      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", olderThan: "30d", now: Date.parse("2026-06-24T00:00:00Z") },
        { runChild, cwd },
      );

      assert.ok(result.ok);
      assert.strictEqual(result.archived.length, 0);
    });
  });

  it("default config (no override) still archives against the literal \"Done\"", async () => {
    await withTempDevloops(null, async (cwd) => {
      const nodes = [rawItemNode("A", 1, { closed: true, closedAt: "2026-01-01T00:00:00Z" })];
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([PROJECT]) },
        { payload: itemsResponse(nodes) },
        { payload: archiveResponse("A") },
      ];
      const runChild = mockRunChild(responses);

      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", olderThan: "30d", now: Date.parse("2026-06-24T00:00:00Z") },
        { runChild, cwd },
      );

      assert.ok(result.ok);
      assert.strictEqual(result.archived.length, 1);
    });
  });

  it("malformed .devloops → archive-done fails CLOSED (surfaces config error), never archives against the literal \"Done\"", async () => {
    await withTempDevloops("queue: renamed\n- broken\n", async (cwd) => {
      const runChild = mockRunChild([]);
      await assert.rejects(
        () => main({ repo: "mfittko/dev-loops", project: "1", now: Date.parse("2026-06-24T00:00:00Z") }, { runChild, cwd }),
        /config read\/parse error/,
      );
    });
  });
});

describe("archive-done — resolveSettings", () => {
  it("returns null when no .devloops is present (default threshold/board apply)", () => {
    withTempDevloops(null, (dir) => {
      assert.strictEqual(resolveSettings(dir), null);
    });
  });

  it("reads archiveOlderThanDays and boardTitle from queue", () => {
    withTempDevloops(
      "queue:\n  boardTitle: \"dev-loops Queue\"\n  archiveOlderThanDays: 14\n",
      (dir) => {
        const s = resolveSettings(dir);
        assert.strictEqual(s.title, "dev-loops Queue");
        assert.strictEqual(s.olderThanDays, 14);
      },
    );
  });

  it("prefers projectNumber over boardTitle for board resolution", () => {
    withTempDevloops(
      "queue:\n  projectNumber: 5\n  boardTitle: \"ignored\"\n",
      (dir) => {
        const s = resolveSettings(dir);
        assert.strictEqual(s.project, 5);
        assert.strictEqual(s.title, undefined);
      },
    );
  });

  it("ignores a non-positive archiveOlderThanDays", () => {
    withTempDevloops(
      "queue:\n  boardTitle: \"b\"\n  archiveOlderThanDays: 0\n",
      (dir) => {
        const s = resolveSettings(dir);
        assert.strictEqual(s.olderThanDays, undefined);
      },
    );
  });
});
