import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SERVER = "codebase-" + "memory";

// The consumer's code-graph server is named only in `.devloops` and in tests.
test("no tracked file outside .devloops and test directories names the code-graph server", () => {
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  const offenders = listed.stdout
    .split("\0")
    .filter((file) => file && file !== ".devloops" && !file.startsWith("test/") && !/^packages\/[^/]+\/test\//.test(file))
    .filter((file) => {
      try {
        return readFileSync(path.join(repoRoot, file), "utf8").includes(SERVER);
      } catch {
        return false;
      }
    });
  assert.deepEqual(offenders, []);
});
