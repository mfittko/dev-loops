import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { test } from "bun:test";
import { sha256Hex } from "@dev-loops/core/loop/review-dispatch-plan";

const source = await readFile(new URL("../../scripts/github/_legacy-fixer-revalidation.mjs", import.meta.url), "utf8");
const candidate = "a".repeat(40);
const treeOid = "b".repeat(40);
const output = Buffer.from(`${candidate}:src/example.mjs:12:readValidationEvidence\n`);
const pattern = "readValidationEvidence|requireBinding|validationResultsPath|prefix-file";
const digest = (bytes) => sha256Hex(bytes).slice(7);

function queryFixture({ bytes = output, failure = {}, drift = null } = {}) {
  const calls = [];
  let scanned = false;
  const native = source.slice(source.indexOf("function nativeGit("), source.indexOf("export async function"));
  const query = runInNewContext(`${native}; queryLegacySites`, {
    Buffer, path, PATTERN: pattern, digest,
    refuse: (reason) => { throw new Error(reason); },
    gitEnvNoDirOverrides: () => ({ GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: "/foreign", GIT_OBJECT_DIRECTORY: "/foreign/objects", GIT_ALTERNATE_OBJECT_DIRECTORIES: "/foreign/alternate", GIT_CONFIG_COUNT: "1", GIT_CONFIG_PARAMETERS: "bad" }),
    spawnSync: (command, args, options) => {
      calls.push({ command, args: [...args], options });
      if (args.includes("grep")) {
        scanned = true;
        return { status: 0, signal: null, stderr: Buffer.alloc(0), stdout: bytes, ...failure };
      }
      return { status: 0, signal: null, stderr: Buffer.alloc(0), stdout: Buffer.from(args.includes("--show-toplevel") ? "/repository\n" : args.at(-1).endsWith("^{tree}") ? `${scanned && drift === "tree" ? candidate : treeOid}\n` : `${scanned && drift === "branch" ? treeOid : candidate}\n`) };
    },
  });
  return { calls, run: () => query({ repoRoot: "/repository/subdirectory", candidate, branch: "issue-1", treeOid, queryOutputBytesDigest: digest(bytes) }) };
}

test("fixed native legacy boundary uses one literal, top-level cwd and bounded scrubbed identity/tree/query calls", () => {
  const fixture = queryFixture();
  const observed = fixture.run();
  assert.deepEqual([...observed.files], ["src/example.mjs"]);
  assert.equal(observed.treeOid, treeOid);
  assert.equal(observed.queryOutputBytesDigest, digest(output));
  assert.equal(fixture.calls.length, 6);
  const grep = fixture.calls.find((call) => call.args.includes("grep"));
  assert.deepEqual(grep.args, ["--no-pager", "-c", "color.ui=never", "grep", "-n", "-E", pattern, candidate, "--"]);
  for (const [index, call] of fixture.calls.entries()) {
    const env = call.options.env;
    assert.equal(call.command, "git");
    assert.equal(call.options.cwd, index ? "/repository" : "/repository/subdirectory");
    assert.equal(call.options.timeout, 10000);
    assert.equal(call.options.killSignal, "SIGKILL");
    assert.equal(call.options.maxBuffer, 1024 * 1024);
    assert.equal(env.GIT_NO_REPLACE_OBJECTS, "1");
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG_PARAMETERS"]) assert.equal(env[key], undefined);
    assert.equal(env.GIT_CONFIG_COUNT, "1");
    assert.equal(env.GIT_CONFIG_KEY_0, "grep.column");
    assert.equal(env.GIT_CONFIG_VALUE_0, "false");
    assert.deepEqual([...call.options.stdio], ["ignore", "pipe", "pipe"]);
    assert.equal(call.options.shell, undefined);
    assert.equal(call.options.encoding, undefined, "hash native bytes before decoding");
  }
});

for (const [name, options] of [
  ["nonzero", { failure: { status: 2, stderr: Buffer.from("invalid regex") } }],
  ["no matches", { failure: { status: 1 } }],
  ["stderr", { failure: { stderr: Buffer.from("truncated") } }],
  ["signal", { failure: { signal: "SIGKILL" } }],
  ["timeout", { failure: { error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) } }],
  ["buffer limit", { failure: { error: Object.assign(new Error("output exceeded limit"), { code: "ENOBUFS" }) } }],
  ["empty", { bytes: Buffer.alloc(0) }],
  ["partial", { bytes: output.subarray(0, -1) }],
  ["mixed malformed", { bytes: Buffer.concat([output, Buffer.from("bad row\n")]) }],
  ["wrong candidate", { bytes: Buffer.from(`${treeOid}:src/example.mjs:12:match\n`) }],
  ["zero line", { bytes: Buffer.from(`${candidate}:src/example.mjs:0:match\n`) }],
  ["traversal", { bytes: Buffer.from(`${candidate}:../secret:1:match\n`) }],
  ["quoted path", { bytes: Buffer.from(`${candidate}:src/../secret:1:match\n`) }],
  ["invalid UTF8", { bytes: Buffer.concat([output.subarray(0, -1), Buffer.from([0xff, 10])]) }],
  ["tree drift", { drift: "tree" }],
  ["branch drift", { drift: "branch" }],
]) test(`native legacy query refuses ${name}`, () => assert.throws(queryFixture(options).run));

test("native permission errors retain their code and are never retried as another executor", () => {
  const denial = Object.assign(new Error("simulated permission denied"), { code: "EACCES" });
  const fixture = queryFixture({ failure: { error: denial } });
  assert.throws(fixture.run, (error) => error === denial);
  assert.equal(fixture.calls.length, 4);
});
