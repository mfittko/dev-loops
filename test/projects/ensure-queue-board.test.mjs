import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { main, autoRepairColumns, resolveSettings, STANDARD_COLUMNS, STANDARD_COLUMN_NAMES } from "../../scripts/projects/ensure-queue-board.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────

function mockRunChild(responses) {
  let callIndex = 0;
  return async (_cmd, args, _env) => {
    if (callIndex >= responses.length) {
      throw new Error(`Unexpected gh call #${callIndex + 1} (only ${responses.length} mocked)`);
    }
    const resp = responses[callIndex++];
    if (resp.error) {
      return { code: 1, stdout: "", stderr: resp.error };
    }
    return { code: 0, stdout: JSON.stringify(resp.payload), stderr: "" };
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────

function userPayload() {
  return { data: { user: { id: "U_kgDOABC123" } } };
}

function orgPayload() {
  return { data: { organization: { id: "O_kgDOXYZ789" } } };
}

function noUserPayload() {
  return { data: { user: null } };
}

function noOrgPayload() {
  return { data: { organization: null } };
}

function repoIdPayload() {
  return { data: { repository: { id: "R_kgDOABC456" } } };
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

function listOrgProjectsResponse(projects) {
  return {
    data: {
      organization: {
        projectsV2: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: projects,
        },
      },
    },
  };
}

function getFieldsResponse(fields) {
  return {
    data: { node: { fields: { nodes: fields } } },
  };
}

function createProjectResponse(project) {
  return {
    data: { createProjectV2: { projectV2: project } },
  };
}

function createFieldResponse(field) {
  return {
    data: { createProjectV2Field: { projectV2Field: field } },
  };
}

function linkRepoResponse() {
  return {
    data: { linkProjectV2ToRepository: { clientMutationId: null } },
  };
}

function updateFieldResponse(options) {
  return {
    data: {
      updateProjectV2Field: {
        projectV2Field: {
          id: "PVTSSF_updated",
          name: "Status",
          options: options ?? [
            { id: "opt1", name: "Backlog", color: "GRAY" },
            { id: "opt2", name: "Next Up", color: "BLUE" },
            { id: "opt3", name: "In Progress", color: "YELLOW" },
            { id: "opt4", name: "Done", color: "GREEN" },
          ],
        },
      },
    },
  };
}

const STATUS_FIELD = {
  id: "PVTSSF_lADO...",
  name: "Status",
  options: [
    { id: "opt1", name: "Backlog" },
    { id: "opt2", name: "Next Up" },
    { id: "opt3", name: "In Progress" },
    { id: "opt4", name: "Done" },
  ],
};

const EXISTING_PROJECT = {
  id: "PVT_kwDO...",
  number: 1,
  title: "Dev Loop Queue",
  url: "https://github.com/users/mfittko/projects/1",
};

// ── Tests ───────────────────────────────────────────────────────────────

describe("ensure-queue-board", () => {
  describe("create path", () => {
    it("creates project and Status field when board does not exist (user)", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([]) },
        {
          payload: createProjectResponse({
            id: "PVT_new",
            number: 2,
            title: "Dev Loop Queue",
            url: "https://github.com/users/mfittko/projects/2",
          }),
        },
        {
          payload: createFieldResponse({ id: "PVTSSF_new", name: "Status" }),
        },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.project.title, "Dev Loop Queue");
      assert.equal(result.project.number, 2);
      assert.ok(result.project.id);
      assert.ok(result.project.url);
      assert.equal(result.project.statusFieldId, "PVTSSF_new");
    });

    it("creates project for org owner", async () => {
      const responses = [
        { payload: noUserPayload() },
        { payload: orgPayload() },
        { payload: listOrgProjectsResponse([]) },
        {
          payload: createProjectResponse({
            id: "PVT_org",
            number: 1,
            title: "Dev Loop Queue",
            url: "https://github.com/orgs/myorg/projects/1",
          }),
        },
        {
          payload: createFieldResponse({ id: "PVTSSF_org", name: "Status" }),
        },
      ];
      const result = await main(
        { repo: "myorg/repo" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.project.number, 1);
    });

    it("uses custom title", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([]) },
        {
          payload: createProjectResponse({
            id: "PVT_custom", number: 3, title: "My Queue",
            url: "https://github.com/users/mfittko/projects/3",
          }),
        },
        {
          payload: createFieldResponse({ id: "PVTSSF_custom", name: "Status" }),
        },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", title: "My Queue" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.project.title, "My Queue");
    });
  });


  describe("--project lookup", () => {
    it("finds project by number when --project is provided", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: 1 },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.project.number, 1);
    });

    it("throws PROJECT_NOT_FOUND when --project number does not match any project", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      ];
      try {
        await main(
          { repo: "mfittko/dev-loops", project: 999 },
          { env: {}, runChild: mockRunChild(responses) },
        );
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.code, "PROJECT_NOT_FOUND");
      }
    });
  });

  describe("--link-repo", () => {
    it("links new project to repo after creation", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([]) },
        {
          payload: createProjectResponse({
            id: "PVT_new",
            number: 2,
            title: "Dev Loop Queue",
            url: "https://github.com/users/mfittko/projects/2",
          }),
        },
        { payload: repoIdPayload() },
        { payload: linkRepoResponse() },
        {
          payload: createFieldResponse({ id: "PVTSSF_new", name: "Status" }),
        },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", linkRepo: "mfittko/dev-loops" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.project.linkedRepo, "mfittko/dev-loops");
      assert.equal(result.project.statusFieldId, "PVTSSF_new");
    });

    it("links existing project to repo", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: repoIdPayload() },
        { payload: linkRepoResponse() },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", linkRepo: "mfittko/dev-loops" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.project.linkedRepo, "mfittko/dev-loops");
    });

    it("validates link-repo format", async () => {
      await assert.rejects(
        () => main({
          repo: "mfittko/dev-loops",
          linkRepo: "not-a-repo",
        }),
        /owner\/name/,
      );
    });
  });

  describe("column auto-repair", () => {
    it("auto-repairs missing columns instead of throwing", async () => {
      const partialField = {
        id: "PVTSSF_partial", name: "Status",
        options: [
          { id: "opt1", name: "Backlog", color: "GRAY" },
        ],
      };
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([partialField]) },
        { payload: updateFieldResponse() },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.project.statusFieldId, "PVTSSF_partial");
    });

    it("auto-repairs completely non-standard columns", async () => {
      const nonStandardField = {
        id: "PVTSSF_nonstd", name: "Status",
        options: [
          { id: "opt1", name: "Todo", color: "RED" },
          { id: "opt2", name: "Doing", color: "YELLOW" },
          { id: "opt3", name: "Done", color: "GREEN" },
        ],
      };
      const expectedOptions = [
        { id: "opt1", name: "Todo", color: "RED" },
        { id: "opt2", name: "Doing", color: "YELLOW" },
        { id: "opt3", name: "Done", color: "GREEN" },
        { id: "new1", name: "Backlog", color: "GRAY" },
        { id: "new2", name: "Next Up", color: "BLUE" },
        { id: "new3", name: "In Progress", color: "YELLOW" },
      ];
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([nonStandardField]) },
        { payload: updateFieldResponse(expectedOptions) },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.project.statusFieldId, "PVTSSF_nonstd");
    });

    it("auto-repairs existing status field and links repo together", async () => {
      const partialField = {
        id: "PVTSSF_partial", name: "Status",
        options: [
          { id: "opt1", name: "In Progress", color: "YELLOW" },
          { id: "opt2", name: "Done", color: "GREEN" },
        ],
      };
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([partialField]) },
        { payload: updateFieldResponse() },
        { payload: repoIdPayload() },
        { payload: linkRepoResponse() },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", linkRepo: "mfittko/dev-loops" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.project.statusFieldId, "PVTSSF_partial");
      assert.equal(result.project.linkedRepo, "mfittko/dev-loops");
    });
  });

  describe("autoRepairColumns unit", () => {
    it("appends missing standard columns to existing options", async () => {
      const existing = [
        { id: "a", name: "Backlog", color: "GRAY" },
      ];
      const updatedOpts = [
        { id: "a", name: "Backlog", color: "GRAY" },
        { id: "n1", name: "Next Up", color: "BLUE" },
        { id: "n2", name: "In Progress", color: "YELLOW" },
        { id: "n3", name: "Done", color: "GREEN" },
      ];
      const responses = [
        { payload: updateFieldResponse(updatedOpts) },
      ];
      const result = await autoRepairColumns(
        "fieldId", existing, {}, mockRunChild(responses),
      );
      assert.equal(result.length, 4);
      assert.deepEqual(result.map((o) => o.name), STANDARD_COLUMN_NAMES);
    });

    it("preserves non-standard columns when adding missing ones", async () => {
      const existing = [
        { id: "a", name: "Custom Column", color: "RED" },
      ];
      const updatedOpts = [
        { id: "a", name: "Custom Column", color: "RED" },
        { id: "n1", name: "Backlog", color: "GRAY" },
        { id: "n2", name: "Next Up", color: "BLUE" },
        { id: "n3", name: "In Progress", color: "YELLOW" },
        { id: "n4", name: "Done", color: "GREEN" },
      ];
      const responses = [
        { payload: updateFieldResponse(updatedOpts) },
      ];
      const result = await autoRepairColumns(
        "fieldId", existing, {}, mockRunChild(responses),
      );
      assert.equal(result.length, 5);
      assert.equal(result[0].name, "Custom Column");
    });

    it("no-ops when all standard columns are present", async () => {
      const existing = STANDARD_COLUMNS.map((c, i) => ({
        id: `opt${i}`, name: c.name, color: c.color,
      }));
      // Should not call gh at all — returns existing options directly
      const result = await autoRepairColumns(
        "fieldId", existing, {}, () => {
          throw new Error("should not be called");
        },
      );
      assert.equal(result, existing);
    });
  });

  describe("already-exists path", () => {
    it("returns existing project when board and Status field exist", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.project.id, "PVT_kwDO...");
      assert.equal(result.project.number, 1);
      assert.equal(result.project.title, "Dev Loop Queue");
      assert.equal(result.project.statusFieldId, "PVTSSF_lADO...");
    });

    it("creates Status field when project exists but field is missing", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([]) },
        {
          payload: createFieldResponse({ id: "PVTSSF_new", name: "Status" }),
        },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.project.statusFieldId, "PVTSSF_new");
    });

    it("handles paginated project listing (>50 projects)", async () => {
      const page1 = {
        data: {
          user: {
            projectsV2: {
              pageInfo: { hasNextPage: true, endCursor: "cursor1" },
              nodes: Array.from({ length: 50 }, (_, i) => ({
                id: `PVT_${i}`, number: i, title: `Project ${i}`,
                url: `https://github.com/users/mfittko/projects/${i}`,
              })),
            },
          },
        },
      };
      const page2 = {
        data: {
          user: {
            projectsV2: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [EXISTING_PROJECT],
            },
          },
        },
      };
      const responses = [
        { payload: userPayload() },
        { payload: page1 },
        { payload: page2 },
        { payload: getFieldsResponse([STATUS_FIELD]) },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.project.number, 1);
    });
  });

  describe("error paths", () => {
    it("throws on invalid repo format", async () => {
      await assert.rejects(() => main({ repo: "not-a-repo" }), /owner\/name/);
    });

    it("throws on repo with extra segments", async () => {
      await assert.rejects(() => main({ repo: "a/b/c" }), /owner\/name/);
    });

    it("throws on whitespace-padded repo", async () => {
      await assert.rejects(() => main({ repo: " owner/repo " }), /whitespace/);
    });

    it("throws on missing repo", async () => {
      await assert.rejects(() => main({}), /required/);
    });

    it("throws on GraphQL API error", async () => {
      const responses = [{ error: "gh: authentication required" }];
      await assert.rejects(
        () => main({ repo: "mfittko/dev-loops" }, { env: {}, runChild: mockRunChild(responses) }),
        /gh api graphql failed/,
      );
    });

    it("throws on GraphQL errors in payload", async () => {
      const responses = [{
        payload: { errors: [{ message: "Could not resolve to a User" }] },
      }];
      await assert.rejects(
        () => main({ repo: "mfittko/dev-loops" }, { env: {}, runChild: mockRunChild(responses) }),
        /GraphQL errors/,
      );
    });

    it("throws when neither user nor org resolves", async () => {
      const responses = [
        { payload: noUserPayload() },
        { payload: noOrgPayload() },
      ];
      await assert.rejects(
        () => main({ repo: "mfittko/dev-loops" }, { env: {}, runChild: mockRunChild(responses) }),
        /Could not resolve owner ID/,
      );
    });

    it("throws when --link-repo has unresolvable repository", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([]) },
        {
          payload: createProjectResponse({
            id: "PVT_new",
            number: 2,
            title: "Dev Loop Queue",
            url: "https://github.com/users/mfittko/projects/2",
          }),
        },
        {
          payload: { data: { repository: null } },
        },
      ];
      await assert.rejects(
        () => main(
          { repo: "mfittko/dev-loops", linkRepo: "nonexistent/repo" },
          { env: {}, runChild: mockRunChild(responses) },
        ),
        /Could not resolve repository ID/,
      );
    });
  });


  describe("resolveSettings integration", () => {
    it("returns project number from .devloops", () => {
      const tmp = mkdtempSync(path.join(import.meta.dirname || "/tmp", "settings-test-"));
      try {
        writeFileSync(path.join(tmp, ".devloops"), [
          "version: 1",
          "queue:",
          "  projectNumber: 42",
        ].join("\n"));
        const result = resolveSettings(tmp);
        assert.deepEqual(result, { project: 42 });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("reads .devloops.yaml extension variant", () => {
      const tmp = mkdtempSync(path.join(import.meta.dirname || "/tmp", "settings-test-"));
      try {
        writeFileSync(path.join(tmp, ".devloops.yaml"), [
          "version: 1",
          "queue:",
          "  boardTitle: From Yaml",
        ].join("\n"));
        const result = resolveSettings(tmp);
        assert.deepEqual(result, { title: "From Yaml" });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("reads .devloops.json extension variant", () => {
      const tmp = mkdtempSync(path.join(import.meta.dirname || "/tmp", "settings-test-"));
      try {
        writeFileSync(path.join(tmp, ".devloops.json"), JSON.stringify({
          version: 1,
          queue: {
            projectNumber: 99,
          },
        }));
        const result = resolveSettings(tmp);
        assert.deepEqual(result, { project: 99 });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("reads .devloops.yml extension variant", () => {
      const tmp = mkdtempSync(path.join(import.meta.dirname || "/tmp", "settings-test-"));
      try {
        writeFileSync(path.join(tmp, ".devloops.yml"), [
          "version: 1",
          "queue:",
          "  boardTitle: From Yml",
        ].join("\n"));
        const result = resolveSettings(tmp);
        assert.deepEqual(result, { title: "From Yml" });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("returns title from settings when projectNumber is absent", () => {
      const tmp = mkdtempSync(path.join(import.meta.dirname || "/tmp", "settings-test-"));
      try {
        writeFileSync(path.join(tmp, ".devloops"), [
          "version: 1",
          "queue:",
          "  boardTitle: My Board",
        ].join("\n"));
        const result = resolveSettings(tmp);
        assert.deepEqual(result, { title: "My Board" });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("returns null when settings file is missing", () => {
      const result = resolveSettings("/nonexistent/path/xyz");
      assert.equal(result, null);
    });
  });


  describe("STANDARD_COLUMNS", () => {
    it("has exactly 4 standard columns in correct order", () => {
      assert.equal(STANDARD_COLUMNS.length, 4);
      assert.deepEqual(STANDARD_COLUMN_NAMES, ["Backlog", "Next Up", "In Progress", "Done"]);
    });
  });
});

describe("rename/reconcile drift", () => {
  const RENAMED_FIELD = {
    id: "PVTSSF_drift",
    name: "Status",
    options: [
      { id: "opt1", name: "Backlog" },
      { id: "opt2", name: "Ready" },
      { id: "opt3", name: "In Progress" },
      { id: "opt4", name: "Done" },
    ],
  };

  const NO_DRIFT_RESPONSES = () => [
    { payload: userPayload() },
    { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
    { payload: getFieldsResponse([STATUS_FIELD]) },
  ];

  it("reports empty repairs when all standard columns are present", async () => {
    const result = await main(
      { repo: "mfittko/dev-loops" },
      { env: {}, runChild: mockRunChild(NO_DRIFT_RESPONSES()) },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.repairs, {
      additive: [],
      renameCandidates: [],
      renamesApplied: [],
      conflicts: [],
    });
  });

  it("detects rename candidates without mutating when flag is absent", async () => {
    // No update response is provided; if the implementation mutates the field,
    // mockRunChild will throw on the unexpected call.
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getFieldsResponse([RENAMED_FIELD]) },
    ];
    const result = await main(
      { repo: "mfittko/dev-loops" },
      { env: {}, runChild: mockRunChild(responses) },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.repairs.renamesApplied, []);
    assert.deepEqual(result.repairs.renameCandidates, [{ from: "Ready", to: "Next Up" }]);
    assert.deepEqual(result.repairs.additive, []); // avoids duplicate Next Up
    assert.deepEqual(result.repairs.conflicts, []);
  });

  it("renames equivalent columns when --repair-rename is authorized", async () => {
    const expectedOptions = [
      { id: "opt1", name: "Backlog" },
      { id: "opt2", name: "Next Up", color: "BLUE" },
      { id: "opt3", name: "In Progress" },
      { id: "opt4", name: "Done" },
    ];
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getFieldsResponse([RENAMED_FIELD]) },
      { payload: updateFieldResponse(expectedOptions) },
    ];
    const result = await main(
      { repo: "mfittko/dev-loops", repairRename: true },
      { env: {}, runChild: mockRunChild(responses) },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.repairs.renamesApplied, [{ from: "Ready", to: "Next Up" }]);
    assert.deepEqual(result.repairs.renameCandidates, []);
    assert.deepEqual(result.repairs.additive, []);
  });

  it("reports conflicts when multiple columns map to the same standard", async () => {
    const conflictField = {
      id: "PVTSSF_conflict",
      name: "Status",
      options: [
        { id: "opt1", name: "Backlog" },
        { id: "opt2", name: "Ready" },
        { id: "opt3", name: "Next" },
        { id: "opt4", name: "In Progress" },
        { id: "opt5", name: "Done" },
      ],
    };
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getFieldsResponse([conflictField]) },
    ];
    const result = await main(
      { repo: "mfittko/dev-loops", repairRename: true },
      { env: {}, runChild: mockRunChild(responses) },
    );
    assert.equal(result.ok, true);
    assert.equal(result.repairs.conflicts.length, 1);
    assert.ok(result.repairs.conflicts[0].reason.includes("Next Up"));
    assert.deepEqual(result.repairs.renamesApplied, []);
  });

  it("adds missing standard columns and detects drift in same repair pass", async () => {
    const mixedField = {
      id: "PVTSSF_mixed",
      name: "Status",
      options: [
        { id: "opt1", name: "Ready" },
        { id: "opt2", name: "In Progress" },
      ],
    };
    const expectedOptions = [
      { id: "opt1", name: "Next Up", color: "BLUE" },
      { id: "opt2", name: "In Progress" },
      { id: "new1", name: "Backlog", color: "GRAY" },
      { id: "new2", name: "Done", color: "GREEN" },
    ];
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getFieldsResponse([mixedField]) },
      { payload: updateFieldResponse(expectedOptions) },
    ];
    const result = await main(
      { repo: "mfittko/dev-loops", repairRename: true },
      { env: {}, runChild: mockRunChild(responses) },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.repairs.renamesApplied, [{ from: "Ready", to: "Next Up" }]);
    assert.deepEqual(result.repairs.additive, ["Backlog", "Done"]);
  });
});

describe("rename conflict when standard already exists", () => {
  it("reports conflict when equivalent column exists alongside the canonical standard", async () => {
    const duplicateStandardField = {
      id: "PVTSSF_dup",
      name: "Status",
      options: [
        { id: "opt1", name: "Backlog" },
        { id: "opt2", name: "Next Up" },
        { id: "opt3", name: "Ready" },
        { id: "opt4", name: "In Progress" },
        { id: "opt5", name: "Done" },
      ],
    };
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getFieldsResponse([duplicateStandardField]) },
    ];
    const result = await main(
      { repo: "mfittko/dev-loops", repairRename: true },
      { env: {}, runChild: mockRunChild(responses) },
    );
    assert.equal(result.ok, true);
    assert.equal(result.repairs.conflicts.length, 1);
    assert.equal(result.repairs.conflicts[0].option, "Ready");
    assert.deepEqual(result.repairs.renamesApplied, []);
    assert.deepEqual(result.repairs.additive, []);
  });

  it("returns repairs on newly created project", async () => {
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([]) },
      {
        payload: createProjectResponse({
          id: "PVT_new",
          number: 2,
          title: "Dev Loop Queue",
          url: "https://github.com/users/mfittko/projects/2",
        }),
      },
      {
        payload: createFieldResponse({ id: "PVTSSF_new", name: "Status" }),
      },
    ];
    const result = await main(
      { repo: "mfittko/dev-loops" },
      { env: {}, runChild: mockRunChild(responses) },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.repairs, {
      additive: [],
      renameCandidates: [],
      renamesApplied: [],
      conflicts: [],
    });
  });
});
