import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";

const scriptPath = path.resolve("scripts/loop/detect-copilot-session-activity.mjs");

const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

async function writeGhStub(tempDir, entries) {
  const { env } = await writeGhStubHelper(tempDir, entries);
  return env;
}

test("detect-copilot-session-activity reports active when matching run is in progress", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-session-active-"));

  try {
    const env = await writeGhStub(tempDir, [{
      assertArgs: ["run", "list", "--repo", "owner/repo", "--branch", "copilot/topic"],
      stdout: `${JSON.stringify([
        {
          databaseId: 101,
          name: "Addressing review on PR owner/repo#17",
          status: "in_progress",
          conclusion: "",
          createdAt: "2026-05-27T11:08:48Z",
        },
      ])}\n`,
    }]);

    const result = await runNode(["--repo", "owner/repo", "--branch", "copilot/topic"], { env });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.activity, "active");
    assert.equal(payload.runId, 101);
    assert.equal(payload.runStatus, "in_progress");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-session-activity prefers the newest matching run over older active runs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-session-newest-wins-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["run", "list", "--repo", "owner/repo", "--branch", "copilot/example-branch", "--limit", "20"],
        stdout: `${JSON.stringify([
          {
            databaseId: 200,
            name: "Addressing comment on PR owner/repo#17",
            status: "completed",
            conclusion: "success",
            createdAt: "2026-05-27T13:10:00Z",
          },
          {
            databaseId: 150,
            name: "Addressing comment on PR owner/repo#17",
            status: "in_progress",
            conclusion: "",
            createdAt: "2026-05-27T13:00:00Z",
          },
        ])}\n`,
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--branch", "copilot/example-branch"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.activity, "concluded");
    assert.equal(payload.runId, 200);
    assert.equal(payload.runStatus, "completed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-session-activity reports concluded when latest matching run completed", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-session-concluded-"));

  try {
    const env = await writeGhStub(tempDir, [{
      assertArgs: ["run", "list", "--repo", "owner/repo", "--branch", "copilot/topic"],
      stdout: `${JSON.stringify([
        {
          databaseId: 110,
          name: "Addressing comment on PR owner/repo#17",
          status: "completed",
          conclusion: "success",
          createdAt: "2026-05-27T12:08:48Z",
        },
        {
          databaseId: 109,
          name: "Addressing review on PR owner/repo#17",
          status: "completed",
          conclusion: "failure",
          createdAt: "2026-05-27T11:08:48Z",
        },
      ])}\n`,
    }]);

    const result = await runNode(["--repo", "owner/repo", "--branch", "copilot/topic"], { env });
    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.activity, "concluded");
    assert.equal(payload.runId, 110);
    assert.equal(payload.runConclusion, "success");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-session-activity treats approval-gated action_required runs as concluded", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-session-action-required-"));

  try {
    const env = await writeGhStub(tempDir, [{
      assertArgs: ["run", "list", "--repo", "owner/repo", "--branch", "copilot/topic"],
      stdout: `${JSON.stringify([
        {
          databaseId: 111,
          name: "Addressing comment on PR owner/repo#17",
          status: "in_progress",
          conclusion: "action_required",
          createdAt: "2026-05-27T12:18:48Z",
        },
      ])}\n`,
    }]);

    const result = await runNode(["--repo", "owner/repo", "--branch", "copilot/topic"], { env });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.activity, "concluded");
    assert.equal(payload.runId, 111);
    assert.equal(payload.runConclusion, "action_required");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-session-activity treats status=action_required as concluded even without a conclusion", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-session-status-action-required-"));

  try {
    const env = await writeGhStub(tempDir, [{
      assertArgs: ["run", "list", "--repo", "owner/repo", "--branch", "copilot/topic"],
      stdout: `${JSON.stringify([
        {
          databaseId: 112,
          name: "Addressing comment on PR owner/repo#17",
          status: "action_required",
          conclusion: null,
          createdAt: "2026-05-27T12:19:48Z",
        },
      ])}
`,
    }]);

    const result = await runNode(["--repo", "owner/repo", "--branch", "copilot/topic"], { env });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.activity, "concluded");
    assert.equal(payload.runId, 112);
    assert.equal(payload.runStatus, "action_required");
    assert.equal(payload.runConclusion, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-session-activity reports idle when no matching run names exist", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-session-idle-"));

  try {
    const env = await writeGhStub(tempDir, [{
      assertArgs: ["run", "list", "--repo", "owner/repo", "--branch", "copilot/topic"],
      stdout: `${JSON.stringify([
        {
          databaseId: 120,
          name: "CI",
          status: "completed",
          conclusion: "success",
          createdAt: "2026-05-27T13:08:48Z",
        },
      ])}\n`,
    }]);

    const result = await runNode(["--repo", "owner/repo", "--branch", "copilot/topic"], { env });
    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.activity, "idle");
    assert.equal(payload.runId, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-session-activity reports idle when branch has no runs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-session-empty-"));

  try {
    const env = await writeGhStub(tempDir, [{
      assertArgs: ["run", "list", "--repo", "owner/repo", "--branch", "copilot/topic"],
      stdout: "[]\n",
    }]);

    const result = await runNode(["--repo", "owner/repo", "--branch", "copilot/topic"], { env });
    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.activity, "idle");
    assert.equal(payload.runId, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
