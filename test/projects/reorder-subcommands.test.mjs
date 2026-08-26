import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../scripts/projects/reorder-queue-item.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────

function mockRunChild(responses) {
  let callIndex = 0;
  const calls = [];
  const fn = async (_cmd, args, _env) => {
    calls.push(args);
    if (callIndex >= responses.length) {
      throw new Error("Unexpected gh call #" + (callIndex + 1) + " (only " + responses.length + " mocked)");
    }
    const resp = responses[callIndex++];
    if (resp.error) {
      return { code: 1, stdout: "", stderr: resp.error };
    }
    return { code: 0, stdout: JSON.stringify(resp.payload), stderr: "" };
  };
  fn.calls = calls;
  return fn;
}

function extractGraphqlInput(args) {
  const vars = {};
  for (const arg of args) {
    if (typeof arg === "string") {
      const eq = arg.indexOf("=");
      if (eq > 0 && !arg.startsWith("query=")) {
        const key = arg.slice(0, eq);
        const value = arg.slice(eq + 1);
        vars[key] = value;
      }
    }
  }
  return Object.keys(vars).length > 0 ? vars : null;
}

function countMutations(calls) {
  return calls.filter((args) =>
    args.some((a) => typeof a === "string" && a.startsWith("query=") && a.includes("mutation")),
  ).length;
}

// ── Fixtures ────────────────────────────────────────────────────────────

function userPayload() {
  return { data: { user: { id: "U_kgDOABC123" } } };
}

function listUserProjectsResponse(projects) {
  return {
    data: {
      user: {
        projectsV2: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: projects,
        },
      },
    },
  };
}

const EXISTING_PROJECT = {
  id: "PVT_proj1",
  number: 1,
  title: "Dev Loop Queue",
  url: "https://github.com/users/mfittko/projects/1",
};

function makeItemContent(ref, typename, repo) {
  return {
    __typename: typename || "Issue",
    number: ref,
    repository: { nameWithOwner: repo || "mfittko/dev-loops" },
  };
}

function makeItemNode(itemId, ref, typename, status) {
  return {
    id: itemId,
    fieldValues: {
      nodes: [
        {
          field: { id: "PVTSSF_status", name: "Status" },
          name: status || "Backlog",
        },
      ],
    },
    content: makeItemContent(ref, typename),
  };
}

function getItemsByContentResponse(items) {
  return {
    data: {
      node: {
        items: {
          nodes: items,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  };
}

function updatePositionResponse() {
  return {
    data: { updateProjectV2ItemPosition: { clientMutationId: null } },
  };
}

// ── move-to-top subcommand ────────────────────────────────────────────────

describe("reorder — move-to-top subcommand", () => {
  it("moves an item to top via positional ref and reports diff", async () => {
    const items = [
      makeItemNode("PVTI_a", 625, "Issue", "Next Up"),
      makeItemNode("PVTI_b", 630, "Issue", "Next Up"),
    ];
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getItemsByContentResponse(items) }, // single fetch: resolve + before snapshot
      { payload: updatePositionResponse() },
      { payload: getItemsByContentResponse([items[1], items[0]]) }, // after-order snapshot
    ];
    const runChild = mockRunChild(responses);

    const result = await main(
      { _subcommand: "move-to-top", _positional: ["630"], repo: "mfittko/dev-loops", project: "1" },
      { runChild },
    );

    assert.ok(result.ok);
    assert.strictEqual(result.item.itemId, "PVTI_b");
    assert.strictEqual(result.item.issueNumber, 630);
    assert.strictEqual(result.item.position, "top");
    assert.ok(Array.isArray(result.before), "before order present");
    assert.ok(Array.isArray(result.after), "after order present");
    assert.deepStrictEqual(result.before.map((x) => x.itemId), ["PVTI_a", "PVTI_b"]);
    assert.deepStrictEqual(result.after.map((x) => x.itemId), ["PVTI_b", "PVTI_a"]);
  });
});

// ── move-after subcommand ─────────────────────────────────────────────────

describe("reorder — move-after subcommand", () => {
  it("moves item after another via two positional refs", async () => {
    const items = [
      makeItemNode("PVTI_630", 630, "Issue", "Next Up"),
      makeItemNode("PVTI_625", 625, "Issue", "Next Up"),
    ];
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getItemsByContentResponse(items) }, // single fetch: resolve both refs + before
      { payload: updatePositionResponse() },
      { payload: getItemsByContentResponse([items[1], items[0]]) }, // after snapshot
    ];
    const runChild = mockRunChild(responses);

    let capturedInput = null;
    const wrapped = async (cmd, args, env) => {
      const r = await runChild(cmd, args, env);
      if (args.some((a) => typeof a === "string" && a.includes("mutation"))) {
        capturedInput = extractGraphqlInput(args);
      }
      return r;
    };
    wrapped.calls = runChild.calls;

    const result = await main(
      { _subcommand: "move-after", _positional: ["630", "625"], repo: "mfittko/dev-loops", project: "1" },
      { runChild: wrapped },
    );

    assert.ok(result.ok);
    assert.strictEqual(result.item.position, "after");
    assert.strictEqual(result.after_ref.itemId, "PVTI_625");
    assert.strictEqual(capturedInput.itemId, "PVTI_630");
    assert.strictEqual(capturedInput.afterId, "PVTI_625");
  });
});

// ── order subcommand ──────────────────────────────────────────────────────

describe("reorder — order subcommand", () => {
  it("sets explicit ordering for a sequence with chained mutations", async () => {
    const items = [
      makeItemNode("PVTI_1", 101, "Issue", "Next Up"),
      makeItemNode("PVTI_2", 102, "Issue", "Next Up"),
      makeItemNode("PVTI_3", 103, "Issue", "Next Up"),
    ];
    // order 103 101 102: single fetch (resolve all + before), 3 mutations, after snapshot (1)
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getItemsByContentResponse(items) }, // single fetch: resolve all refs + before
      { payload: updatePositionResponse() }, // 103 -> top
      { payload: updatePositionResponse() }, // 101 -> after 103
      { payload: updatePositionResponse() }, // 102 -> after 101
      { payload: getItemsByContentResponse([items[2], items[0], items[1]]) }, // after snapshot
    ];
    const runChild = mockRunChild(responses);

    const result = await main(
      { _subcommand: "order", _positional: ["103", "101", "102"], repo: "mfittko/dev-loops", project: "1" },
      { runChild },
    );

    assert.ok(result.ok);
    assert.strictEqual(result.moves.length, 3);
    assert.strictEqual(result.moves[0].position, "top");
    assert.strictEqual(result.moves[1].position, "after");
    assert.strictEqual(result.moves[2].position, "after");
    assert.strictEqual(countMutations(runChild.calls), 3);
    assert.deepStrictEqual(result.after.map((x) => x.itemId), ["PVTI_3", "PVTI_1", "PVTI_2"]);
  });

  it("fails closed when refs span different Status columns (no mutation)", async () => {
    const items = [
      makeItemNode("PVTI_1", 101, "Issue", "Next Up"),
      makeItemNode("PVTI_2", 102, "Issue", "In Progress"), // different column
    ];
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getItemsByContentResponse(items) }, // single resolve fetch
    ];
    const runChild = mockRunChild(responses);

    await assert.rejects(
      () => main({ _subcommand: "order", _positional: ["101", "102"], repo: "mfittko/dev-loops", project: "1" }, { runChild }),
      (err) => err.code === "MIXED_STATUS" && /same Status column/.test(err.message),
    );
    assert.strictEqual(countMutations(runChild.calls), 0, "no mutation on a mixed-status plan");
  });
});

describe("reorder — order partial-failure recovery", () => {
  it("reports how many moves were applied when a mid-sequence mutation fails", async () => {
    const items = [
      makeItemNode("PVTI_1", 101, "Issue", "Next Up"),
      makeItemNode("PVTI_2", 102, "Issue", "Next Up"),
      makeItemNode("PVTI_3", 103, "Issue", "Next Up"),
    ];
    // order 103 101 102: single fetch (resolve all + before), mutation 1 ok, mutation 2 fails
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getItemsByContentResponse(items) }, // single fetch: resolve all refs + before
      { payload: updatePositionResponse() }, // move 1 ok
      { error: "boom" }, // move 2 fails
    ];
    const runChild = mockRunChild(responses);

    await assert.rejects(
      () => main(
        { _subcommand: "order", _positional: ["103", "101", "102"], repo: "mfittko/dev-loops", project: "1" },
        { runChild },
      ),
      (err) => {
        assert.strictEqual(err.appliedMoves, 1);
        assert.strictEqual(err.totalMoves, 3);
        assert.match(err.message, /order partially applied: 1 of 3/);
        assert.match(err.message, /re-run the same order command/);
        return true;
      },
    );
  });
});

// ── --dry-run ─────────────────────────────────────────────────────────────

describe("reorder — --dry-run", () => {
  it("prints intended mutations without executing them (move-to-top)", async () => {
    const items = [makeItemNode("PVTI_b", 630, "Issue", "Next Up")];
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getItemsByContentResponse(items) }, // single fetch: resolve + before snapshot
    ];
    const runChild = mockRunChild(responses);

    const result = await main(
      { _subcommand: "move-to-top", _positional: ["630"], repo: "mfittko/dev-loops", project: "1", dryRun: true },
      { runChild },
    );

    assert.ok(result.ok);
    assert.strictEqual(result.dryRun, true);
    assert.ok(Array.isArray(result.mutations));
    assert.strictEqual(result.mutations.length, 1);
    assert.ok(result.mutations[0].query.includes("updateProjectV2ItemPosition"));
    assert.strictEqual(result.mutations[0].variables.itemId, "PVTI_b");
    assert.ok(Array.isArray(result.before), "before snapshot present in dry-run");
    // No mutation gh calls were made
    assert.strictEqual(countMutations(runChild.calls), 0);
  });

  it("prints all chained mutations for order without executing", async () => {
    const items = [
      makeItemNode("PVTI_1", 101, "Issue", "Next Up"),
      makeItemNode("PVTI_2", 102, "Issue", "Next Up"),
    ];
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getItemsByContentResponse(items) }, // single fetch: resolve all refs + before
    ];
    const runChild = mockRunChild(responses);

    const result = await main(
      { _subcommand: "order", _positional: ["102", "101"], repo: "mfittko/dev-loops", project: "1", dryRun: true },
      { runChild },
    );

    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(result.mutations.length, 2);
    assert.strictEqual(result.mutations[0].variables.afterId ?? null, null);
    assert.strictEqual(result.mutations[1].variables.afterId, "PVTI_2");
    assert.strictEqual(countMutations(runChild.calls), 0);
  });
});

// ── legacy flag form ──────────────────────────────────────────────────────

describe("reorder — legacy flag form", () => {
  it("rejects a stray positional argument (fail closed)", async () => {
    const runChild = mockRunChild([]); // should never reach a gh call
    await assert.rejects(
      () => main(
        { _positional: ["630"], repo: "mfittko/dev-loops", project: "1", item: "630" },
        { runChild },
      ),
      (err) => err.code === "INVALID_ARGS" && /Unexpected argument: 630/.test(err.message),
    );
  });

  it("includes a before snapshot in --dry-run output (parity with subcommands)", async () => {
    const items = [makeItemNode("PVTI_b", 630, "Issue", "Next Up")];
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getItemsByContentResponse(items) }, // single fetch: resolve + before snapshot
    ];
    const runChild = mockRunChild(responses);

    const result = await main(
      { _positional: [], repo: "mfittko/dev-loops", project: "1", item: "630", dryRun: true },
      { runChild },
    );

    assert.ok(result.ok);
    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(result.mutations.length, 1);
    assert.strictEqual(result.mutations[0].variables.itemId, "PVTI_b");
    assert.deepStrictEqual(result.before, [
      { itemId: "PVTI_b", issueNumber: 630, prNumber: null, status: "Next Up" },
    ]);
    // Only ONE fetch-all-items call (no separate resolve + snapshot fetch).
    assert.strictEqual(
      runChild.calls.filter((args) => args.some((a) => typeof a === "string" && a.startsWith("query="))).length,
      3,
    );
    assert.strictEqual(countMutations(runChild.calls), 0);
  });
});

// ── issue vs PR ref ───────────────────────────────────────────────────────

describe("reorder — issue and PR refs", () => {
  it("resolves a PR item ref for move-to-top", async () => {
    const items = [makeItemNode("PVTI_pr", 88, "PullRequest", "Next Up")];
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getItemsByContentResponse(items) }, // single fetch: resolve + before
      { payload: updatePositionResponse() },
      { payload: getItemsByContentResponse(items) }, // after snapshot
    ];
    const runChild = mockRunChild(responses);

    const result = await main(
      { _subcommand: "move-to-top", _positional: ["88"], repo: "mfittko/dev-loops", project: "1" },
      { runChild },
    );

    assert.ok(result.ok);
    assert.strictEqual(result.item.prNumber, 88);
    assert.strictEqual(result.item.issueNumber, null);
  });
});

// ── cross-project / not found error ───────────────────────────────────────

describe("reorder — cross-project error", () => {
  it("returns clear ITEM_NOT_FOUND when ref is not in the target project", async () => {
    const items = [makeItemNode("PVTI_other", 630, "Issue", "Next Up", "Next Up")];
    // item belongs to a different repo -> filtered out
    items[0].content.repository.nameWithOwner = "other/repo";
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getItemsByContentResponse(items) },
    ];
    const runChild = mockRunChild(responses);

    await assert.rejects(
      () => main(
        { _subcommand: "move-to-top", _positional: ["630"], repo: "mfittko/dev-loops", project: "1" },
        { runChild },
      ),
      (err) => err.code === "ITEM_NOT_FOUND" && /not found in project/.test(err.message),
    );
  });

  it("fails closed when an item NODE ID ref belongs to another repo", async () => {
    // The item id exists on the board but its content is in a different repo.
    const items = [makeItemNode("PVTI_other", 630, "Issue", "Next Up", "Next Up")];
    items[0].content.repository.nameWithOwner = "other/repo";
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getItemsByContentResponse(items) }, // single fetch
    ];
    const runChild = mockRunChild(responses);

    await assert.rejects(
      () => main(
        { _subcommand: "move-to-top", _positional: ["PVTI_other"], repo: "mfittko/dev-loops", project: "1" },
        { runChild },
      ),
      (err) => err.code === "ITEM_NOT_FOUND" && /not found in project for repo/.test(err.message),
    );
  });
});
