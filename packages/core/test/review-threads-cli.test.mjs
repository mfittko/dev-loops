import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

function runNode(scriptPath, args = [], options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    if (options.stdin) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }

    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

const cliPath = path.resolve("packages/core/bin/parse-review-threads.mjs");
const fixturePath = path.resolve("packages/core/test/fixtures/github/review-threads/mixed-threads.json");

test("parse-review-threads CLI emits stable machine-readable success output", async () => {
  const result = await runNode(cliPath, ["--input", fixturePath]);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");

  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.summary, {
    totalThreads: 3,
    unresolvedThreads: 2,
    actionableThreads: 1,
    actionableComments: 1,
  });
  assert.equal(output.ok, true);
  assert.equal(output.threads[0].id, "t-1");
  assert.equal(output.comments[1].id, "c-2");
  assert.equal(output.comments[1].isActionable, false);
  assert.equal(output.comments[3].id, "c-4");
});

test("parse-review-threads CLI reports invalid JSON deterministically", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-review-cli-"));
  const invalidPath = path.join(tempDir, "invalid.json");

  try {
    await writeFile(invalidPath, "{not-json}\n", "utf8");
    const result = await runNode(cliPath, ["--input", invalidPath]);

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      ok: false,
      error: "Invalid JSON input",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("parse-review-threads CLI rejects missing option values deterministically", async () => {
  const result = await runNode(cliPath, ["--input"]);

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    ok: false,
    error: "Missing value for --input",
  });
});

test("parse-review-threads CLI rejects unknown arguments deterministically", async () => {
  const result = await runNode(cliPath, ["--wat"]);

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    ok: false,
    error: "Unknown argument: --wat",
  });
});
