import assert from "node:assert/strict";
import * as fs from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { ensureWritableNpmCacheEnv, makeJsonGhStub, runNode, withTempDir } from "./_helpers.mjs";

// <!-- rule-ref: OPS-WRITABLE-TOOL-CACHE -->
test("npm cache setup preserves explicit and writable default caches; falls back before consuming npm", async () => {
  await withTempDir(async (directory) => {
    const env = { PATH: process.env.PATH };
    const calls = [];
    const run = (command, args, options) => {
      calls.push({ command, args, env: options.env });
      return directory;
    };
    const explicit = { ...env, npm_config_cache: "explicit-cache" };
    assert.equal(ensureWritableNpmCacheEnv(explicit, { run }), explicit);
    assert.equal(calls.length, 0);
    assert.equal(ensureWritableNpmCacheEnv(env, { run }), env);
    // Inject an unwritable default rather than causing a real runtime denial.
    const fallback = ensureWritableNpmCacheEnv(env, { run, fs: { ...fs, mkdirSync(target, options) {
      if (target.startsWith(directory)) throw new Error("fixture read-only cache");
      return fs.mkdirSync(target, options);
    } } });
    assert.notEqual(fallback.npm_config_cache, directory);
    assert.equal(fallback.PATH, env.PATH);
    fs.writeFileSync(path.join(fallback.npm_config_cache, "proof"), "ok");
    fs.rmSync(fallback.npm_config_cache, { recursive: true, force: true });
    assert.ok(calls.every(({ command, args, env: received }) => command === "npm" && args.join(" ") === "config get cache" && received === env));
    assert.deepEqual(fs.readdirSync(path.join(directory, "_cacache/tmp")), []);
    assert.throws(() => ensureWritableNpmCacheEnv(env, { run, fs: {
      ...fs,
      mkdirSync() { throw new Error("fixture default unavailable"); },
      mkdtempSync() { throw new Error("fixture temp unavailable"); },
    } }), /npm cache setup: no writable cache directory .*OPS-WRITABLE-TOOL-CACHE/);
    assert.ok(calls.every(({ args }) => args.join(" ") === "config get cache"));
  });
});

test("makeJsonGhStub: success serializes the payload; failure emits empty stdout + stderr; the entry repeats", async () => {
  const ok = makeJsonGhStub({ number: 7, state: "OPEN" });
  const first = await ok.run("gh", ["issue", "view", "7"]);
  assert.equal(first.code, 0);
  assert.deepEqual(JSON.parse(first.stdout), { number: 7, state: "OPEN" });
  // repeatLastOnOverflow: a second call still resolves from the single entry.
  const second = await ok.run("gh", ["issue", "view", "7", "--json", "state"]);
  assert.equal(JSON.parse(second.stdout).number, 7);
  assert.equal(ok.calls.length, 2);

  const failed = await makeJsonGhStub(null, { code: 1, stderr: "no such issue" }).run("gh", ["issue", "view", "9"]);
  assert.equal(failed.code, 1);
  assert.equal(failed.stdout, "");
  assert.equal(failed.stderr, "no such issue");
});

test("runNode preserves child termination signals in its result and stderr", async () => {
  await withTempDir(async (directory) => {
    const script = path.join(directory, "terminate.mjs");
    await writeFile(script, [
      "process.stderr.write('context without newline');",
      "process.kill(process.pid, 'SIGTERM');",
      "setInterval(() => {}, 1_000);",
    ].join("\n"));

    const result = await runNode(script);
    assert.equal(result.code, null);
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.stderr, "context without newline\nrunNode: child terminated by signal SIGTERM\n");
  }, { prefix: "run-node-signal-" });
});
