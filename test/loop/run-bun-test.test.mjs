import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { buildBunTestArgs, childResult, createOutputCapture, discoverRepositoryTests, parseBunSummary, resolveBunTestFiles, resolveBunTestParallelism, runBunTest } from "../../scripts/run-bun-test.mjs";

test("launcher applies local and CI parallelism with failure-only shared workers", () => {
  assert.deepEqual(buildBunTestArgs(["example.test.mjs"], {}), ["test", "--only-failures", "--path-ignore-patterns=tmp/**", "--parallel=8", "--no-isolate", "example.test.mjs"]);
  assert.deepEqual(buildBunTestArgs(["--shard=1/4"], { BUN_TEST_PARALLELISM: "2" }), ["test", "--only-failures", "--path-ignore-patterns=tmp/**", "--parallel=2", "--no-isolate", "--shard=1/4"]);
  for (const value of ["0", "-1", "2.5", "many"]) assert.throws(
    () => resolveBunTestParallelism({ BUN_TEST_PARALLELISM: value }),
    /positive integer/,
  );
});

test("launcher centrally deduplicates canonical reporting and discovery flags", () => {
  const args = buildBunTestArgs([
    "--only-failures", "--only-failures",
    "--path-ignore-patterns=tmp/**", "--path-ignore-patterns", "tmp/**",
    "--path-ignore-patterns=generated/**", "example.test.mjs",
  ], {});
  assert.equal(args.filter((arg) => arg === "--only-failures").length, 1);
  assert.equal(args.filter((arg) => arg === "--path-ignore-patterns=tmp/**").length, 1);
  assert.equal(args.filter((arg) => arg === "tmp/**").length, 0);
  assert.ok(args.includes("--path-ignore-patterns=generated/**"));
});

test("Bun summaries retain counts, files, and time without successful chatter", () => {
  const summary = parseBunSummary("passing child says:\n 99 pass\n 0 fail\nRan 99 tests across 9 files. [1.00ms]\n\nnpm notice noisy tarball\n{\"heartbeat\":true}\n\n 2 pass\n 1 skip\n 0 fail\nRan 3 tests across 2 files. [123.00ms]\n");
  assert.equal(summary, "bun test: 2 pass, 1 skip, 0 fail across 2 files (123.00ms)\n");
  assert.equal(parseBunSummary("not a Bun summary\n"), null);
});

function fakeChild(write, closeArgs = [0, null]) {
  return (_command, _args, options) => {
    const child = new EventEmitter();
    write(options.stdio[1]);
    queueMicrotask(() => child.emit("close", ...closeArgs));
    return child;
  };
}

function memoryCapture(content, events, { summaryError, replayError, cleanupError } = {}) {
  return {
    fd: 42,
    finish: async () => events.push("finish"),
    readTail: async () => {
      events.push("read-tail");
      if (summaryError) throw summaryError;
      return content;
    },
    replay: async (stream) => {
      events.push("replay");
      if (replayError) throw replayError;
      stream.write(content);
    },
    cleanup: async () => {
      events.push("cleanup");
      if (cleanupError) throw cleanupError;
    },
  };
}

test("successful runs suppress captured stdout and stderr and emit one compact summary", async () => {
  const events = [];
  let stdout = "";
  let stderr = "";
  const content = "npm notice noisy tarball\n{\"heartbeat\":true}\n 1 pass\n 0 fail\nRan 1 test across 1 file. [4.00ms]\n";
  const code = await runBunTest(["example.test.mjs"], {
    captureFactory: async () => memoryCapture(content, events),
    spawnImpl: fakeChild(() => {}),
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
  });
  assert.equal(code, 0);
  assert.equal(stdout, "bun test: 1 pass, 0 skip, 0 fail across 1 file (4.00ms)\n");
  assert.equal(stderr, "");
  assert.doesNotMatch(stdout, /npm notice|heartbeat/);
  assert.deepEqual(events, ["finish", "read-tail", "cleanup"]);
});

test("descriptor capture reads a bounded tail, replays the file, and removes it", async () => {
  const capture = await createOutputCapture();
  const prefix = "first diagnostic\n";
  const suffix = " 1 pass\n 0 fail\nRan 1 test across 1 file. [4.00ms]\n";
  writeSync(capture.fd, `${prefix}${"x".repeat(70 * 1024)}${suffix}`);
  await capture.finish();
  const tail = await capture.readTail();
  assert.ok(Buffer.byteLength(tail) <= 64 * 1024);
  assert.doesNotMatch(tail, /first diagnostic/);
  assert.match(tail, /Ran 1 test across 1 file/);
  let replay = "";
  await capture.replay({ write: (chunk) => { replay += chunk; } });
  assert.ok(replay.startsWith(prefix));
  assert.ok(replay.endsWith(suffix));
  await capture.cleanup();
  await assert.rejects(access(capture.path));
});

test("nonzero and signaled runs replay complete diagnostics and preserve failure", async () => {
  for (const [closeArgs, expected] of [[[7, null], 7], [[null, "SIGTERM"], 1]]) {
    const events = [];
    let stderr = "";
    const content = "first diagnostic\nlast diagnostic\n";
    const code = await runBunTest(["example.test.mjs"], {
      captureFactory: async () => memoryCapture(content, events),
      spawnImpl: fakeChild(() => {}, closeArgs),
      stderr: { write: (chunk) => { stderr += chunk; } },
    });
    assert.equal(code, expected);
    assert.match(stderr, /^first diagnostic\nlast diagnostic\n/);
    if (closeArgs[1]) assert.match(stderr, /SIGTERM/);
    assert.deepEqual(events, ["finish", "replay", "cleanup"]);
  }
});

test("a child that closes without a code or signal replays diagnostics and reports abnormal termination", async () => {
  const events = [];
  let stderr = "";
  const code = await runBunTest(["example.test.mjs"], {
    captureFactory: async () => memoryCapture("child diagnostics\n", events),
    spawnImpl: fakeChild(() => {}, [null, null]),
    stderr: { write: (chunk) => { stderr += chunk; } },
  });
  assert.equal(code, 1);
  assert.match(stderr, /^child diagnostics\n/);
  assert.match(stderr, /closed without an exit code or signal/);
  assert.deepEqual(events, ["finish", "replay", "cleanup"]);
});

test("capture finalization failure replays a real tempfile before cleanup removes it", async () => {
  const events = [];
  let closeAttempts = 0;
  let capture;
  let stderr = "";
  await assert.rejects(
    runBunTest(["example.test.mjs"], {
      captureFactory: async () => {
        capture = await createOutputCapture({
          closeHandle: async (handle) => {
            closeAttempts += 1;
            events.push(`close-${closeAttempts}`);
            if (closeAttempts === 1) throw new Error("close failed");
            await handle.close();
          },
        });
        return capture;
      },
      spawnImpl: fakeChild((fd) => writeSync(fd, "real tempfile diagnostics\n")),
      stderr: { write: (chunk) => { stderr += chunk; events.push("replay"); } },
    }),
    /capture finalization failed/,
  );
  assert.match(stderr, /real tempfile diagnostics/);
  assert.deepEqual(events, ["close-1", "replay", "close-2"]);
  await assert.rejects(access(capture.path));
});

test("spawn and capture failures are loud, replay what exists, and always clean up", async () => {
  for (const failure of ["spawn", "summary", "replay", "cleanup"]) {
    const events = [];
    let stderr = "";
    const content = failure === "cleanup"
      ? "complete diagnostics\n 1 pass\n 0 fail\nRan 1 test across 1 file. [4.00ms]\n"
      : "complete diagnostics\n";
    const capture = memoryCapture(content, events, {
      summaryError: failure === "summary" ? new Error("tail read failed") : undefined,
      replayError: failure === "replay" ? new Error("replay failed") : undefined,
      cleanupError: failure === "cleanup" ? new Error("cleanup failed") : undefined,
    });
    const spawnImpl = failure === "spawn"
      ? () => { const child = new EventEmitter(); queueMicrotask(() => child.emit("error", new Error("spawn denied"))); return child; }
      : fakeChild(() => {}, failure === "replay" ? [3, null] : [0, null]);
    await assert.rejects(
      runBunTest(["example.test.mjs"], { captureFactory: async () => capture, spawnImpl, stderr: { write: (chunk) => { stderr += chunk; } } }),
      new RegExp(failure === "spawn" ? "spawn denied" : failure === "summary" ? "tail read failed" : `${failure} failed`),
    );
    assert.ok(events.includes("cleanup"));
    if (failure === "cleanup") {
      assert.ok(!events.includes("replay"));
    } else {
      assert.ok(events.includes("replay"));
    }
    if (["spawn", "summary"].includes(failure)) assert.match(stderr, /complete diagnostics/);
  }
});

test("all package scripts that invoke Bun's test runner route through the wrapper", async () => {
  const pkg = JSON.parse(await readFile(path.resolve(import.meta.dir, "../../package.json"), "utf8"));
  for (const [name, script] of Object.entries(pkg.scripts)) {
    if (/\bbun\s+test\b/.test(script)) assert.match(script, /scripts\/run-bun-test\.mjs/, name);
  }
  for (const name of ["test:all", "test:assets", "test:doc-guard", "test:extension", "test:scripts", "test:core", "test:dev-loop", "test:pack"]) {
    assert.match(pkg.scripts[name], /scripts\/run-bun-test\.mjs/, name);
  }
});

test("canonical Bun discovery probe", () => {
  assert.equal(1, 1);
});

test("canonical execution excludes matching tests in two repository tmp namespaces", async () => {
  const root = path.resolve(import.meta.dir, "../..");
  const relative = "test/loop/run-bun-test.test.mjs";
  const stale = ["tmp/worktrees/issue-2013-probe", "tmp/copilot-loop/issue-2013-probe"];
  try {
    for (const namespace of stale) {
      const target = path.join(root, namespace, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `import { test } from "bun:test";\ntest("canonical Bun discovery probe", () => { throw new Error("TMP LEAK ${namespace}"); });\n`);
    }
    const child = Bun.spawn([
      process.execPath, "scripts/run-bun-test.mjs",
      "--test-name-pattern=canonical Bun discovery probe", relative,
    ], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_TEST_PARALLELISM: "1" } });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    assert.equal(exitCode, 0, stderr);
    assert.match(stdout, /1 pass, 0 skip, 0 fail across 1 file/);
    assert.doesNotMatch(`${stdout}\n${stderr}`, /TMP LEAK/);
  } finally {
    await Promise.all(stale.map((namespace) => rm(path.join(root, namespace), { recursive: true, force: true })));
  }
});

test("launcher expands the complete inventory without consuming Bun flags", async () => {
  const args = await resolveBunTestFiles(["--shard=2/4", "--all"]);
  assert.equal(args[0], "--shard=2/4");
  assert.deepEqual(args.slice(1), await discoverRepositoryTests());
  for (const file of ["test/loop/test-inventory.test.mjs", "packages/core/test/config.test.mjs", "skills/dev-loop/scripts/render-template.test.mjs"]) assert.ok(args.includes(file));
});

test("shared child result settles when a spawn error has no close event", async () => {
  const child = new EventEmitter();
  const error = new Error("spawn failed");
  const result = childResult(child);
  child.emit("error", error);
  assert.deepEqual(await result, { code: 1, error, signal: undefined });
});
