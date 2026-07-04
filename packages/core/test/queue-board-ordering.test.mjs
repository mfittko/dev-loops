import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveNextUpOrder } from "../src/loop/queue-board-ordering.mjs";

async function makeRepo(configYaml) {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-board-ordering-"));
  if (configYaml) {
    await writeFile(path.join(dir, ".devloops"), configYaml);
  }
  return dir;
}

test("resolveNextUpOrder returns configured:false when board not configured", async () => {
  const dir = await makeRepo(null);
  try {
    const result = await resolveNextUpOrder("owner/repo", dir, {});
    assert.equal(result.ok, true);
    assert.equal(result.configured, false);
    assert.deepEqual(result.order, []);
    assert.equal(result.reason, "board not configured");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveNextUpOrder returns ok:true, configured:true, empty order for a genuinely empty Next Up", async () => {
  const dir = await makeRepo("queue:\n  projectNumber: 3\n");
  try {
    const result = await resolveNextUpOrder(
      "owner/repo",
      dir,
      { GH_TOKEN: "mock" },
      { listQueueItems: async () => ({ ok: true, items: [] }) },
    );
    // Successful query, zero items → NOT an error; the driver fails closed/idles.
    assert.equal(result.ok, true);
    assert.equal(result.configured, true);
    assert.deepEqual(result.order, []);
    assert.equal(result.reason, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveNextUpOrder returns order from mocked list helper", async () => {
  const dir = await makeRepo("queue:\n  projectNumber: 3\n");
  try {
    const result = await resolveNextUpOrder(
      "owner/repo",
      dir,
      { GH_TOKEN: "mock" },
      {
        listQueueItems: async (args) => {
          // list-queue-items' CLI contract requires `project` as a string ref;
          // resolveNextUpOrder must stringify the resolved number (#901).
          assert.deepEqual(args, { repo: "owner/repo", project: "3", column: "Next Up" });
          return {
            ok: true,
            items: [
              { issueNumber: 10, prNumber: null },
              { issueNumber: null, prNumber: 20 },
              { issueNumber: 30 },
            ],
          };
        },
      },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.order, [10, 20, 30]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Real integration: title-only config → real list-queue-items path ──────
//
// Regression guard for #901. The earlier tests stub `listQueueItems`, so the
// real `resolveProjectNumber` (title→number) + `listQueueItemsMain` integration
// was never exercised — which hid the number-vs-string `--project` mismatch.
// This test stubs ONLY the `gh`/`runChild` layer with realistic Projects-v2
// payloads, routing each GraphQL query by its shape.

/**
 * Build a runChild stub that answers the gh GraphQL queries issued by the real
 * resolveProjectNumber → listQueueItemsMain path for a title-only board config.
 */
function makeGhStub({ projects, statusOptions, items }) {
  return async (_cmd, args) => {
    const queryIdx = args.findIndex((a) => typeof a === "string" && a.startsWith("query="));
    const query = queryIdx >= 0 ? args[queryIdx].slice("query=".length) : "";

    const respond = (data) => ({ code: 0, stdout: JSON.stringify({ data }), stderr: "" });

    // Owner resolution: GET_USER_ID
    if (query.includes("user(login:$login) { id }")) {
      return respond({ user: { id: "U_owner" } });
    }
    // Project listing: LIST_USER_PROJECTS (title → number / id)
    if (query.includes("projectsV2(first:50")) {
      return respond({
        user: {
          projectsV2: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: projects,
          },
        },
      });
    }
    // Fields: GET_PROJECT_FIELDS (Status single-select)
    if (query.includes("fields(first:50")) {
      return respond({
        node: {
          fields: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ id: "F_status", name: "Status", options: statusOptions }],
          },
        },
      });
    }
    // Items: GET_PROJECT_ITEMS
    if (query.includes("items(first:100")) {
      return respond({
        node: {
          items: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: items,
          },
        },
      });
    }
    throw new Error(`unexpected gh query: ${query.slice(0, 60)}`);
  };
}

test("resolveNextUpOrder resolves Next Up from a title-only config (real list-queue-items path)", async () => {
  const dir = await makeRepo('queue:\n  boardTitle: "dev-loops Queue"\n');
  try {
    const statusOptions = [
      { id: "opt_next", name: "Next Up" },
      { id: "opt_prog", name: "In Progress" },
    ];
    const mkItem = (id, number, status) => ({
      id,
      fieldValues: {
        nodes: [{ field: { id: "F_status", name: "Status" }, name: status }],
      },
      content: { number, title: `Issue ${number}`, url: `https://x/${number}`, id: `I_${number}` },
    });
    const runChild = makeGhStub({
      projects: [
        { id: "PVT_other", number: 1, title: "Other board", url: "u1" },
        { id: "PVT_queue", number: 3, title: "dev-loops Queue", url: "u3" },
      ],
      statusOptions,
      items: [
        mkItem("it1", 101, "Next Up"),
        mkItem("it2", 102, "In Progress"),
        mkItem("it3", 103, "Next Up"),
      ],
    });

    const result = await resolveNextUpOrder("owner/repo", dir, { GH_TOKEN: "mock" }, { runChild });
    assert.equal(result.ok, true);
    assert.equal(result.reason, null);
    // Only the Next Up items, in position order.
    assert.deepEqual(result.order, [101, 103]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveNextUpOrder yields a clean reason (not '--project is required') when the board title is unresolvable", async () => {
  // Distinct repo + title so the module-level resolveProjectNumber cache from
  // the prior test does not satisfy this lookup.
  const dir = await makeRepo('queue:\n  boardTitle: "Missing Board"\n');
  try {
    const runChild = makeGhStub({
      // No project matching the configured title → resolveProjectNumber throws
      // BOARD_NOT_FOUND, surfaced as a clear reason.
      projects: [{ id: "PVT_other", number: 1, title: "Other board", url: "u1" }],
      statusOptions: [],
      items: [],
    });
    const result = await resolveNextUpOrder("owner/missingrepo", dir, { GH_TOKEN: "mock" }, { runChild });
    // Board configured but unresolvable → query ERROR (fail-closed at driver),
    // not a fail-open empty. Still carries order:[]/reason for the membership layer.
    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.deepEqual(result.order, []);
    assert.notEqual(result.reason, "--project is required");
    assert.match(result.reason, /not found under/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveNextUpOrder queries the configured statusColumns.next_up display name (#1098)", async () => {
  const dir = await makeRepo('queue:\n  projectNumber: 3\n  statusColumns:\n    next_up: "Todo"\n');
  try {
    const result = await resolveNextUpOrder(
      "owner/repo",
      dir,
      { GH_TOKEN: "mock" },
      {
        listQueueItems: async (args) => {
          assert.deepEqual(args, { repo: "owner/repo", project: "3", column: "Todo" });
          return { ok: true, items: [{ issueNumber: 5 }] };
        },
      },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.order, [5]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveNextUpOrder reports ok:false on list query error (fail-closed at driver)", async () => {
  const dir = await makeRepo("queue:\n  projectNumber: 3\n");
  try {
    const result = await resolveNextUpOrder(
      "owner/repo",
      dir,
      { GH_TOKEN: "mock" },
      {
        listQueueItems: async () => {
          throw new Error("GraphQL timeout");
        },
      },
    );
    // Query error → ok:false so the driver surfaces it and stops (no Backlog
    // fallback). order/reason preserved for the fail-open membership layer.
    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.deepEqual(result.order, []);
    assert.equal(result.reason, "GraphQL timeout");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
