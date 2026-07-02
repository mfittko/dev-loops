import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../scripts/projects/reorder-queue-item.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────

function mockRunChild(responses) {
  let callIndex = 0;
  return async (_cmd, args, _env) => {
    if (callIndex >= responses.length) {
      throw new Error("Unexpected gh call #" + (callIndex + 1) + " (only " + responses.length + " mocked)");
    }
    const resp = responses[callIndex++];
    if (resp.error) {
      return { code: 1, stdout: "", stderr: resp.error };
    }
    return { code: 0, stdout: JSON.stringify(resp.payload), stderr: "" };
  };
}

function extractGraphqlInput(args) {
  // gh sends: ["api", "graphql", "--raw-field", "query=...", "--raw-field", "projectId=...", ...]
  const vars = {};
  for (const arg of args) {
    if (typeof arg === "string") {
      const eq = arg.indexOf("=");
      if (eq > 0 && !arg.startsWith("query=")) {
        const key = arg.slice(0, eq);
        const value = arg.slice(eq + 1);
        if (value !== "null" && value !== "undefined") {
          vars[key] = value;
        }
      }
    }
  }
  return Object.keys(vars).length > 0 ? vars : null;
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

function emptyItemsResponse() {
  return getItemsByContentResponse([]);
}

function getProjectItemResponse(itemId, itemContent) {
  return {
    data: {
      node: {
        item: {
          id: itemId,
          fieldValues: {
            nodes: [
              {
                field: { id: "PVTSSF_status", name: "Status" },
                name: "Backlog",
              },
            ],
          },
          content: itemContent ?? {
            __typename: "Issue",
            number: 630,
            title: "Test Issue",
            url: "https://github.com/mfittko/dev-loops/issues/630",
          },
        },
      },
    },
  };
}

function updatePositionResponse() {
  return {
    data: {
      updateProjectV2ItemPosition: {
        clientMutationId: null,
      },
    },
  };
}

function makeItemContent(ref, typename, repo) {
  return {
    __typename: typename || "Issue",
    number: ref,
    repository: { nameWithOwner: repo || "mfittko/dev-loops" },
  };
}

function makeItemNode(itemId, ref, typename) {
  return {
    id: itemId,
    fieldValues: {
      nodes: [
        {
          field: { id: "PVTSSF_status", name: "Status" },
          name: "Backlog",
        },
      ],
    },
    content: makeItemContent(ref, typename),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("reorder-queue-item — move to top (no --after)", () => {
  it("moves an item to top by issue number", async () => {
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getItemsByContentResponse([makeItemNode("PVTI_item_1", 630)]) },
      { payload: updatePositionResponse() },
    ];
    const runChild = mockRunChild(responses);

    // Intercept the mutation call to check input
    const orig = runChild;
    let capturedInput = null;
    const wrapped = async (cmd, args, env) => {
      const result = await orig(cmd, args, env);
      // The mutation is the 4th call (index 3 in responses)
      // extract input from gh args
      const input = extractGraphqlInput(args);
      if (input !== null) capturedInput = input;
      return result;
    };

    const result = await main(
      { repo: "mfittko/dev-loops", project: "1", item: "630" },
      { runChild: wrapped },
    );

    assert.ok(result.ok);
    assert.strictEqual(result.item.itemId, "PVTI_item_1");
    assert.strictEqual(result.item.issueNumber, 630);
    assert.strictEqual(result.item.position, "top");
    assert.strictEqual(result.after, null);
    assert.ok(capturedInput !== null, "Should have captured mutation input");
    assert.strictEqual(capturedInput.projectId, "PVT_proj1");
    assert.strictEqual(capturedInput.itemId, "PVTI_item_1");
    assert.strictEqual("afterId" in capturedInput, false);
  });

  it("moves an item to top by item node ID", async () => {
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      {
        payload: getProjectItemResponse("PVTI_item_x", {
          __typename: "PullRequest",
          number: 88,
          title: "PR",
          url: "...",
        }),
      },
      { payload: updatePositionResponse() },
    ];
    const runChild = mockRunChild(responses);

    let capturedInput = null;
    const wrapped = async (cmd, args, env) => {
      const result = await runChild(cmd, args, env);
      const input = extractGraphqlInput(args);
      if (input !== null) capturedInput = input;
      return result;
    };

    const result = await main(
      { repo: "mfittko/dev-loops", project: "1", item: "PVTI_item_x" },
      { runChild: wrapped },
    );

    assert.ok(result.ok);
    assert.strictEqual(result.item.itemId, "PVTI_item_x");
    assert.strictEqual(result.item.prNumber, 88);
    assert.strictEqual(result.item.position, "top");
    assert.strictEqual(result.after, null);
    assert.ok(capturedInput !== null);
    assert.strictEqual(capturedInput.afterId, undefined);
  });
});

describe("reorder-queue-item — move after another item", () => {
  it("moves an item after another by issue numbers", async () => {
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getItemsByContentResponse([makeItemNode("PVTI_item_630", 630)]) },
      { payload: getItemsByContentResponse([makeItemNode("PVTI_item_625", 625)]) },
      { payload: updatePositionResponse() },
    ];
    const runChild = mockRunChild(responses);

    let capturedInput = null;
    const wrapped = async (cmd, args, env) => {
      const result = await runChild(cmd, args, env);
      const input = extractGraphqlInput(args);
      if (input !== null) capturedInput = input;
      return result;
    };

    const result = await main(
      { repo: "mfittko/dev-loops", project: "1", item: "630", after: "625" },
      { runChild: wrapped },
    );

    assert.ok(result.ok);
    assert.strictEqual(result.item.position, "after");
    assert.strictEqual(result.after.itemId, "PVTI_item_625");
    assert.strictEqual(result.after.issueNumber, 625);
    assert.ok(capturedInput !== null);
    assert.strictEqual(capturedInput.projectId, "PVT_proj1");
    assert.strictEqual(capturedInput.itemId, "PVTI_item_630");
    assert.strictEqual(capturedInput.afterId, "PVTI_item_625");
  });

  it("fails closed when after item is not found", async () => {
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getItemsByContentResponse([makeItemNode("PVTI_item_630", 630)]) },
      { payload: emptyItemsResponse() },
    ];
    const runChild = mockRunChild(responses);

    await assert.rejects(
      () => main(
        { repo: "mfittko/dev-loops", project: "1", item: "630", after: "999" },
        { runChild },
      ),
      (err) => err.code === "ITEM_NOT_FOUND",
    );
  });

  it("fails closed when item is same as after item", async () => {
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getItemsByContentResponse([makeItemNode("PVTI_item_630", 630)]) },
      { payload: getItemsByContentResponse([makeItemNode("PVTI_item_630", 630)]) },
    ];
    const runChild = mockRunChild(responses);

    await assert.rejects(
      () => main(
        { repo: "mfittko/dev-loops", project: "1", item: "630", after: "630" },
        { runChild },
      ),
      (err) => err.message.includes("itself"),
    );
  });
});

describe("reorder-queue-item — error handling", () => {
  it("fails closed when item is not found", async () => {
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: emptyItemsResponse() },
    ];
    const runChild = mockRunChild(responses);

    await assert.rejects(
      () => main(
        { repo: "mfittko/dev-loops", project: "1", item: "999" },
        { runChild },
      ),
      (err) => err.code === "ITEM_NOT_FOUND",
    );
  });

  it("fails closed when project is not found", async () => {
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([]) },
    ];
    const runChild = mockRunChild(responses);

    await assert.rejects(
      () => main(
        { repo: "mfittko/dev-loops", project: "99", item: "630" },
        { runChild },
      ),
      (err) => err.code === "PROJECT_NOT_FOUND",
    );
  });
});

describe("reorder-queue-item — URI project resolution", () => {
  it("resolves a user-scoped board URI without a resolveOwner round-trip", async () => {
    const responses = [
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getItemsByContentResponse([makeItemNode("PVTI_item_1", 630)]) },
      { payload: updatePositionResponse() },
    ];
    const result = await main(
      {
        repo: "mfittko/dev-loops",
        project: "https://github.com/users/mfittko/projects/1",
        item: "630",
      },
      { runChild: mockRunChild(responses) },
    );
    assert.ok(result.ok);
    assert.strictEqual(result.item.itemId, "PVTI_item_1");
    assert.strictEqual(result.item.issueNumber, 630);
    assert.strictEqual(result.item.position, "top");
  });
});

describe("reorder-queue-item — mutation input construction", () => {
  it("constructs top-position mutation input correctly", async () => {
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getItemsByContentResponse([makeItemNode("PVTI_item_1", 630)]) },
      { payload: updatePositionResponse() },
    ];
    const runChild = mockRunChild(responses);

    let capturedInput = null;
    const wrapped = async (cmd, args, env) => {
      const result = await runChild(cmd, args, env);
      const input = extractGraphqlInput(args);
      if (input !== null) capturedInput = input;
      return result;
    };

    await main(
      { repo: "mfittko/dev-loops", project: "1", item: "630" },
      { runChild: wrapped },
    );

    assert.deepStrictEqual(capturedInput, {
      projectId: "PVT_proj1",
      itemId: "PVTI_item_1",
    });
    assert.strictEqual("afterId" in capturedInput, false);
  });

  it("constructs after-item mutation input correctly", async () => {
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getItemsByContentResponse([makeItemNode("PVTI_item_630", 630)]) },
      { payload: getProjectItemResponse("PVTI_item_625", makeItemContent(625)) },
      { payload: updatePositionResponse() },
    ];
    const runChild = mockRunChild(responses);

    let capturedInput = null;
    const wrapped = async (cmd, args, env) => {
      const result = await runChild(cmd, args, env);
      const input = extractGraphqlInput(args);
      if (input !== null) capturedInput = input;
      return result;
    };

    await main(
      { repo: "mfittko/dev-loops", project: "1", item: "630", after: "PVTI_item_625" },
      { runChild: wrapped },
    );

    assert.deepStrictEqual(capturedInput, {
      projectId: "PVT_proj1",
      itemId: "PVTI_item_630",
      afterId: "PVTI_item_625",
    });
  });
});
