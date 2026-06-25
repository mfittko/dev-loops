import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  OPEN_PR_LIST_LIMIT,
  listOpenPrs,
} from "../../scripts/loop/_loop-pr-aggregation.mjs";

async function withFakeGh(stdout, { code = 0, stderr = "" } = {}, run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "loop-pr-agg-"));
  const ghPath = path.join(dir, "gh");
  const script = `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(stdout)});
process.stderr.write(${JSON.stringify(stderr)});
process.exit(${code});
`;
  await writeFile(ghPath, script, "utf8");
  await chmod(ghPath, 0o755);
  try {
    return await run(ghPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("listOpenPrs normalizes, filters, and sorts the gh payload", async () => {
  const payload = JSON.stringify([
    { number: 7, title: "Seven", url: "u7", isDraft: true, headRefName: "f7", author: { login: "alice" } },
    { number: 3, title: "Three", url: "u3", isDraft: false, headRefName: "f3", author: { login: "bob" } },
    { number: null, title: "skip-no-number" },
    { number: 5 },
  ]);
  const prs = await withFakeGh(payload, {}, (ghPath) =>
    listOpenPrs({ repo: "owner/repo" }, { env: process.env, ghCommand: ghPath }),
  );
  assert.deepEqual(prs, [
    { number: 3, title: "Three", url: "u3", isDraft: false, headRefName: "f3", authorLogin: "bob" },
    { number: 5, title: "", url: null, isDraft: false, headRefName: null, authorLogin: null },
    { number: 7, title: "Seven", url: "u7", isDraft: true, headRefName: "f7", authorLogin: "alice" },
  ]);
});

test("listOpenPrs throws on gh failure", async () => {
  await withFakeGh("", { code: 1, stderr: "boom" }, async (ghPath) => {
    await assert.rejects(
      listOpenPrs({ repo: "owner/repo" }, { env: process.env, ghCommand: ghPath }),
      /gh command failed: boom/,
    );
  });
});

test("listOpenPrs throws when payload is not an array", async () => {
  await withFakeGh(JSON.stringify({ not: "array" }), {}, async (ghPath) => {
    await assert.rejects(
      listOpenPrs({ repo: "owner/repo" }, { env: process.env, ghCommand: ghPath }),
      /expected an array/,
    );
  });
});

test("OPEN_PR_LIST_LIMIT is the shared constant", () => {
  assert.equal(OPEN_PR_LIST_LIMIT, 1000);
});
