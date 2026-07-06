import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main, enqueueIssuelessLightweightPr } from "../../scripts/github/create-pr.mjs";
import { runNode as runNodeHelper, writeGhStub } from "../_helpers.mjs";

const scriptPath = path.resolve("scripts/github/create-pr.mjs");
const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

// mockRunChild mirrors test/projects/add-queue-item.test.mjs's fixture style: a
// sequential list of canned gh-graphql responses, bypassing any real subprocess.
function mockRunChild(responses) {
  let callIndex = 0;
  return async () => {
    if (callIndex >= responses.length) {
      throw new Error(`Unexpected gh call #${callIndex + 1} (only ${responses.length} mocked)`);
    }
    const resp = responses[callIndex++];
    return { code: 0, stdout: JSON.stringify(resp), stderr: "" };
  };
}

const STATUS_FIELD = {
  id: "PVTSSF_status",
  name: "Status",
  options: [
    { id: "opt1", name: "Backlog" },
    { id: "opt2", name: "Next Up" },
    { id: "opt3", name: "In Progress" },
    { id: "opt4", name: "Done" },
  ],
};

const PROJECT = { id: "PVT_proj1", number: 7, title: "Dev Loop Queue", url: "https://github.com/users/owner/projects/7" };

function userPayload() {
  return { data: { user: { id: "U_kgDOABC123" } } };
}
function listUserProjectsResponse(projects) {
  return { data: { user: { projectsV2: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: projects } } } };
}
function getFieldsResponse(fields) {
  return { data: { node: { fields: { nodes: fields, pageInfo: { hasNextPage: false } } } } };
}
function itemsByContentResponse(items) {
  return { data: { node: { items: { nodes: items, pageInfo: { hasNextPage: false, endCursor: null } } } } };
}
function resolvePrResponse(id) {
  return { data: { repository: { issueOrPullRequest: { id, __typename: "PullRequest" } } } };
}
function addItemResponse(itemId) {
  return { data: { addProjectV2ItemById: { item: { id: itemId } } } };
}
function updateFieldResponse() {
  return { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_new" } } } };
}

async function withTempDir(fn) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-board-"));
  try {
    await fn(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function writeDevloopsProjectNumber(tempDir, projectNumber) {
  await writeFile(path.join(tempDir, ".devloops"), `queue:\n  projectNumber: ${projectNumber}\n`, "utf8");
}

// --- enqueueIssuelessLightweightPr unit tests (AC1, AC3, AC4) ---

test("enqueueIssuelessLightweightPr: no .devloops board configured is a silent no-op", async () => {
  await withTempDir(async (tempDir) => {
    const board = await enqueueIssuelessLightweightPr({
      repo: "owner/repo",
      prNumber: 42,
      cwd: tempDir,
      env: {},
      runChild: mockRunChild([]),
    });
    assert.deepEqual(board, { enqueued: false, reason: "no-board-configured" });
  });
});

test("enqueueIssuelessLightweightPr: adds a new PR item in In Progress", async () => {
  await withTempDir(async (tempDir) => {
    await writeDevloopsProjectNumber(tempDir, 7);
    const responses = [
      userPayload(),
      listUserProjectsResponse([PROJECT]),
      getFieldsResponse([STATUS_FIELD]),
      itemsByContentResponse([]),
      resolvePrResponse("PR_kwDO_42"),
      addItemResponse("PVTI_new"),
      updateFieldResponse(),
    ];
    const board = await enqueueIssuelessLightweightPr({
      repo: "owner/repo",
      prNumber: 42,
      cwd: tempDir,
      env: {},
      runChild: mockRunChild(responses),
    });
    assert.deepEqual(board, {
      enqueued: true,
      itemId: "PVTI_new",
      prNumber: 42,
      status: "In Progress",
      alreadyPresent: false,
    });
  });
});

test("enqueueIssuelessLightweightPr: idempotent — an already-present item is not duplicated", async () => {
  await withTempDir(async (tempDir) => {
    await writeDevloopsProjectNumber(tempDir, 7);
    const existing = {
      id: "PVTI_existing",
      fieldValues: { nodes: [{ field: { id: "PVTSSF_status", name: "Status" }, name: "In Progress" }] },
      content: { __typename: "PullRequest", number: 42, repository: { nameWithOwner: "owner/repo" } },
    };
    const responses = [
      userPayload(),
      listUserProjectsResponse([PROJECT]),
      getFieldsResponse([STATUS_FIELD]),
      itemsByContentResponse([existing]),
    ];
    const board = await enqueueIssuelessLightweightPr({
      repo: "owner/repo",
      prNumber: 42,
      cwd: tempDir,
      env: {},
      runChild: mockRunChild(responses),
    });
    assert.deepEqual(board, {
      enqueued: true,
      itemId: "PVTI_existing",
      prNumber: 42,
      status: "In Progress",
      alreadyPresent: true,
    });
  });
});

test("enqueueIssuelessLightweightPr: missing --repo is a no-op, never calls gh", async () => {
  await withTempDir(async (tempDir) => {
    await writeDevloopsProjectNumber(tempDir, 7);
    const board = await enqueueIssuelessLightweightPr({
      repo: null,
      prNumber: 42,
      cwd: tempDir,
      env: {},
      runChild: mockRunChild([]),
    });
    assert.deepEqual(board, { enqueued: false, reason: "repo-not-specified" });
  });
});

test("enqueueIssuelessLightweightPr: unparsed PR number is a no-op, never calls gh", async () => {
  await withTempDir(async (tempDir) => {
    await writeDevloopsProjectNumber(tempDir, 7);
    const board = await enqueueIssuelessLightweightPr({
      repo: "owner/repo",
      prNumber: null,
      cwd: tempDir,
      env: {},
      runChild: mockRunChild([]),
    });
    assert.deepEqual(board, { enqueued: false, reason: "pr-number-not-parsed" });
  });
});

// --- main() end-to-end: gh pr create over a stubbed gh, board calls mocked in-process ---

test("create-pr --lightweight on an issue-less body enqueues the new PR board item (AC1)", async () => {
  await withTempDir(async (tempDir) => {
    await writeDevloopsProjectNumber(tempDir, 7);
    const { env } = await writeGhStub(tempDir, [{ stdout: "https://github.com/owner/repo/pull/42\n" }]);

    const responses = [
      userPayload(),
      listUserProjectsResponse([PROJECT]),
      getFieldsResponse([STATUS_FIELD]),
      itemsByContentResponse([]),
      resolvePrResponse("PR_kwDO_42"),
      addItemResponse("PVTI_new"),
      updateFieldResponse(),
    ];

    const originalWrite = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = (chunk) => {
      captured += chunk;
      return true;
    };
    let code;
    try {
      code = await main(
        ["--repo", "owner/repo", "--base", "main", "--head", "feature", "--title", "t", "--body", "no closing keyword here", "--lightweight"],
        { env, cwd: tempDir, runChild: mockRunChild(responses) },
      );
    } finally {
      process.stdout.write = originalWrite;
    }

    assert.equal(code, 0);
    assert.match(captured, /https:\/\/github\.com\/owner\/repo\/pull\/42/);
    const boardLine = captured.trim().split("\n").at(-1);
    assert.deepEqual(JSON.parse(boardLine), {
      board: { enqueued: true, itemId: "PVTI_new", prNumber: 42, status: "In Progress", alreadyPresent: false },
    });
  });
});

test("create-pr --lightweight with a Closes #N body is tracker-backed and byte-identical: no board call (AC2)", async () => {
  await withTempDir(async (tempDir) => {
    await writeDevloopsProjectNumber(tempDir, 7);
    const { env, ghLogPath } = await writeGhStub(tempDir, [{ stdout: "https://github.com/owner/repo/pull/42\n" }], { logCalls: true });

    const result = await runNode(
      ["--repo", "owner/repo", "--base", "main", "--head", "feature", "--title", "t", "--body", "Closes #9", "--lightweight"],
      { env, cwd: tempDir },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "https://github.com/owner/repo/pull/42\n");
    const ghCalls = (await readFile(ghLogPath, "utf8")).trim().split("\n").filter(Boolean);
    assert.equal(ghCalls.length, 1); // gh pr create only — no board calls
  });
});

test("create-pr --lightweight on a no-board repo is a silent no-op noted in the JSON line (AC3)", async () => {
  await withTempDir(async (tempDir) => {
    const { env } = await writeGhStub(tempDir, [{ stdout: "https://github.com/owner/repo/pull/42\n" }]);

    const originalWrite = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = (chunk) => {
      captured += chunk;
      return true;
    };
    let code;
    try {
      code = await main(
        ["--repo", "owner/repo", "--base", "main", "--head", "feature", "--title", "t", "--body", "no closing keyword", "--lightweight"],
        { env, cwd: tempDir, runChild: mockRunChild([]) },
      );
    } finally {
      process.stdout.write = originalWrite;
    }

    assert.equal(code, 0);
    const boardLine = captured.trim().split("\n").at(-1);
    assert.deepEqual(JSON.parse(boardLine), { board: { enqueued: false, reason: "no-board-configured" } });
  });
});

test("create-pr --lightweight without --body/--body-file never enqueues: reason body-not-provided (no explicit body source)", async () => {
  await withTempDir(async (tempDir) => {
    await writeDevloopsProjectNumber(tempDir, 7);
    const { env, ghLogPath } = await writeGhStub(tempDir, [{ stdout: "https://github.com/owner/repo/pull/42\n" }], { logCalls: true });

    const result = await runNode(
      ["--repo", "owner/repo", "--base", "main", "--head", "feature", "--title", "t", "--fill", "--lightweight"],
      { env, cwd: tempDir },
    );

    assert.equal(result.code, 0);
    const boardLine = result.stdout.trim().split("\n").at(-1);
    assert.deepEqual(JSON.parse(boardLine), { board: { enqueued: false, reason: "body-not-provided" } });
    const ghCalls = (await readFile(ghLogPath, "utf8")).trim().split("\n").filter(Boolean);
    assert.equal(ghCalls.length, 1); // gh pr create only — no board calls
  });
});

test("create-pr --lightweight with --repo=owner/repo (equals form) enqueues the PR board item", async () => {
  await withTempDir(async (tempDir) => {
    await writeDevloopsProjectNumber(tempDir, 7);
    const { env } = await writeGhStub(tempDir, [{ stdout: "https://github.com/owner/repo/pull/42\n" }]);

    const responses = [
      userPayload(),
      listUserProjectsResponse([PROJECT]),
      getFieldsResponse([STATUS_FIELD]),
      itemsByContentResponse([]),
      resolvePrResponse("PR_kwDO_42"),
      addItemResponse("PVTI_new"),
      updateFieldResponse(),
    ];

    const originalWrite = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = (chunk) => {
      captured += chunk;
      return true;
    };
    let code;
    try {
      code = await main(
        // --base directly after --repo= proves the value comes from the inline
        // token, not the next argv element.
        ["--repo=owner/repo", "--base", "main", "--head", "feature", "--title", "t", "--body", "no closing keyword here", "--lightweight"],
        { env, cwd: tempDir, runChild: mockRunChild(responses) },
      );
    } finally {
      process.stdout.write = originalWrite;
    }

    assert.equal(code, 0);
    const boardLine = captured.trim().split("\n").at(-1);
    assert.deepEqual(JSON.parse(boardLine), {
      board: { enqueued: true, itemId: "PVTI_new", prNumber: 42, status: "In Progress", alreadyPresent: false },
    });
  });
});

test("create-pr without --lightweight never calls the board and never prints a board JSON line", async () => {
  await withTempDir(async (tempDir) => {
    await writeDevloopsProjectNumber(tempDir, 7);
    const { env, ghLogPath } = await writeGhStub(tempDir, [{ stdout: "https://github.com/owner/repo/pull/42\n" }], { logCalls: true });

    const result = await runNode(
      ["--repo", "owner/repo", "--base", "main", "--head", "feature", "--title", "t", "--body", "no closing keyword"],
      { env, cwd: tempDir },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "https://github.com/owner/repo/pull/42\n");
    const ghCalls = (await readFile(ghLogPath, "utf8")).trim().split("\n").filter(Boolean);
    assert.equal(ghCalls.length, 1); // gh pr create only — no board calls
  });
});

// --- --lightweight boolean forms: every token consumed, last occurrence wins ---
// No .devloops board in the temp cwd, so an ENABLED run reports the
// no-board-configured JSON line (proof the flag was consumed and honored)
// while a DISABLED run prints the plain PR URL only. Either way the gh log
// must never contain a --lightweight token.

async function runLightweightForms(tempDir, lightweightTokens) {
  const { env, ghLogPath } = await writeGhStub(tempDir, [{ stdout: "https://github.com/owner/repo/pull/42\n" }], { logCalls: true });
  const result = await runNode(
    ["--repo", "owner/repo", "--base", "main", "--head", "feature", "--title", "t", "--body", "no closing keyword", ...lightweightTokens],
    { env, cwd: tempDir },
  );
  assert.equal(result.code, 0);
  const ghCalls = (await readFile(ghLogPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(ghCalls.length, 1); // gh pr create only — no board calls (no board configured)
  assert.equal(ghCalls[0].some((arg) => arg.startsWith("--lightweight")), false); // consumed, never forwarded
  return result.stdout;
}

test("create-pr --lightweight=true enables the lightweight path (inline boolean form)", async () => {
  await withTempDir(async (tempDir) => {
    const stdout = await runLightweightForms(tempDir, ["--lightweight=true"]);
    assert.deepEqual(JSON.parse(stdout.trim().split("\n").at(-1)), { board: { enqueued: false, reason: "no-board-configured" } });
  });
});

test("create-pr --lightweight=false disables the lightweight path and is NOT forwarded to gh", async () => {
  await withTempDir(async (tempDir) => {
    const stdout = await runLightweightForms(tempDir, ["--lightweight=false"]);
    assert.equal(stdout, "https://github.com/owner/repo/pull/42\n");
  });
});

test("create-pr --lightweight=false then bare --lightweight: last occurrence wins (enabled)", async () => {
  await withTempDir(async (tempDir) => {
    const stdout = await runLightweightForms(tempDir, ["--lightweight=false", "--lightweight"]);
    assert.deepEqual(JSON.parse(stdout.trim().split("\n").at(-1)), { board: { enqueued: false, reason: "no-board-configured" } });
  });
});

test("create-pr bare --lightweight then --lightweight=false: last occurrence wins (disabled)", async () => {
  await withTempDir(async (tempDir) => {
    const stdout = await runLightweightForms(tempDir, ["--lightweight", "--lightweight=false"]);
    assert.equal(stdout, "https://github.com/owner/repo/pull/42\n");
  });
});
