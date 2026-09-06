import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { buildBunTestArgs, childResult, createOutputCapture, createTestProgress, discoverRepositoryTests, parseBunSummary, resolveBunTestFiles, resolveBunTestParallelism, runBunTest } from "../../scripts/run-bun-test.mjs";

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

test("explicit dots replaces failure-only reporting while keeping canonical discovery", () => {
  const args = buildBunTestArgs(["--only-failures", "--dots", "example.test.mjs"], {});
  assert.ok(args.includes("--dots"));
  assert.ok(!args.includes("--only-failures"));
  assert.equal(args.filter((arg) => arg === "--path-ignore-patterns=tmp/**").length, 1);
});

test("Bun summaries require a consistent terminal reporter block", () => {
  const summary = parseBunSummary("passing child says:\nnpm notice noisy tarball\n{\"heartbeat\":true}\n\n 2 pass\n 1 skip\n 0 fail\nRan 3 tests across 2 files. [123.00ms]\n");
  assert.equal(summary, "bun test: 2 pass, 1 skip, 0 fail across 2 files (123.00ms)\n");
  assert.equal(parseBunSummary("not a Bun summary\n"), null);
  assert.equal(parseBunSummary(" 2 pass\n 1 skip\n 0 fail\nRan 4 tests across 2 files. [123.00ms]\n"), null);
  assert.equal(parseBunSummary(" 2 pass\n 0 fail\nRan 2 tests across 1 file. [1.00ms]\nlate exit-handler output\n 9 pass\n 0 fail\nRan 9 tests across 9 files. [9.00ms]\nspoof trailer\n"), null);
});

function fakeIntervals() {
  const active = new Set();
  return {
    active,
    setIntervalImpl(callback, delay) {
      const timer = { callback, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
      active.add(timer);
      return timer;
    },
    clearIntervalImpl(timer) { active.delete(timer); },
    tick() { for (const timer of [...active]) timer.callback(); },
  };
}

test("progress is one in-place TTY status and clears without leaking its timer", () => {
  const timers = fakeIntervals();
  let output = "";
  let clock = 0;
  const progress = createTestProgress({
    stream: { isTTY: true, write: (chunk) => { output += chunk; } },
    now: () => clock,
    ...timers,
  });
  progress.start();
  assert.equal([...timers.active][0].delay, 250);
  assert.equal([...timers.active][0].unrefCalled, true);
  clock = 1_400;
  timers.tick();
  clock = 2_600;
  timers.tick();
  progress.stop();
  assert.match(output, /^\rbun test [|/] running \(0s\)/);
  assert.match(output, /running \(1s\)/);
  assert.match(output, /running \(2s\)/);
  assert.ok(output.endsWith("\r\x1b[2K"));
  assert.equal(timers.active.size, 0);
});

test("non-TTY progress is a compact 15-second heartbeat and dots is immediately observable", () => {
  for (const [dots, initialPattern] of [[false, /^$/], [true, /^bun test: running \(--dots\) \(0s\)\n$/]]) {
    const timers = fakeIntervals();
    let output = "";
    let clock = 0;
    const progress = createTestProgress({
      stream: { isTTY: false, write: (chunk) => { output += chunk; } },
      dots,
      now: () => clock,
      ...timers,
    });
    progress.start();
    assert.equal([...timers.active][0].delay, 15_000);
    assert.equal([...timers.active][0].unrefCalled, true);
    assert.match(output, initialPattern);
    clock = 15_000;
    timers.tick();
    assert.match(output, /bun test: still running \(15s\)\n$/);
    progress.stop();
    assert.equal(timers.active.size, 0);
  }
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

test("dots stays observable while passing fixture chatter remains captured", async () => {
  const events = [];
  let childArgs;
  let stdout = "";
  let stderr = "";
  const timers = fakeIntervals();
  const content = "passing fixture chatter\n 1 pass\n 0 fail\nRan 1 test across 1 file. [4.00ms]\n";
  const code = await runBunTest(["--dots", "example.test.mjs"], {
    captureFactory: async () => memoryCapture(content, events),
    spawnImpl: (_command, args) => {
      childArgs = args;
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { isTTY: false, write: (chunk) => { stderr += chunk; } },
    progressFactory: (options) => createTestProgress({ ...options, ...timers, now: () => 0 }),
  });
  assert.equal(code, 0);
  assert.ok(childArgs.includes("--dots"));
  assert.ok(!childArgs.includes("--only-failures"));
  assert.equal(stderr, "bun test: running (--dots) (0s)\n");
  assert.doesNotMatch(`${stdout}${stderr}`, /passing fixture chatter/);
  assert.equal(timers.active.size, 0);
});

test("progress timers stop across normal, child-failure, signal, spawn, and capture-error outcomes", async () => {
  const summary = " 1 pass\n 0 fail\nRan 1 test across 1 file. [1.00ms]\n";
  const cases = [
    { spawnImpl: fakeChild(() => {}), captureFactory: async () => memoryCapture(summary, []) },
    { spawnImpl: fakeChild(() => {}, [2, null]), captureFactory: async () => memoryCapture("failed\n", []) },
    { spawnImpl: fakeChild(() => {}, [null, "SIGTERM"]), captureFactory: async () => memoryCapture("signaled\n", []) },
    { spawnImpl: () => { throw new Error("spawn threw"); }, captureFactory: async () => memoryCapture("", []) },
    { spawnImpl: fakeChild(() => {}), captureFactory: async () => { throw new Error("capture setup failed"); } },
    { spawnImpl: fakeChild(() => {}), captureFactory: async () => memoryCapture(summary, [], { cleanupError: new Error("capture cleanup failed") }) },
  ];
  for (const options of cases) {
    const timers = fakeIntervals();
    try {
      await runBunTest(["example.test.mjs"], {
        ...options,
        stdout: { write() {} },
        stderr: { isTTY: false, write() {} },
        progressFactory: (progressOptions) => createTestProgress({ ...progressOptions, ...timers, now: () => 0 }),
      });
    } catch {}
    assert.equal(timers.active.size, 0);
  }
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
    assert.ok(events.includes("replay"));
    if (["spawn", "summary", "cleanup"].includes(failure)) assert.match(stderr, /complete diagnostics/);
  }
});

test("cleanup failure replays diagnostics and never emits a misleading success summary", async () => {
  const events = [];
  let stdout = "";
  let stderr = "";
  const content = "complete diagnostics\n 1 pass\n 0 fail\nRan 1 test across 1 file. [4.00ms]\n";
  await assert.rejects(runBunTest(["example.test.mjs"], {
    captureFactory: async () => memoryCapture(content, events, { cleanupError: new Error("cleanup failed") }),
    spawnImpl: fakeChild(() => {}),
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
  }), /cleanup failed/);
  assert.equal(stdout, "");
  assert.match(stderr, /complete diagnostics/);
  assert.deepEqual(events, ["finish", "read-tail", "cleanup", "replay"]);
});

test("partial spool removal retains real diagnostics until cleanup-error replay completes", async () => {
  const events = [];
  let capture;
  let stdout = "";
  let stderr = "";
  const content = "first real diagnostic\nlast real diagnostic\n 1 pass\n 0 fail\nRan 1 test across 1 file. [4.00ms]\n";
  await assert.rejects(runBunTest(["example.test.mjs"], {
    captureFactory: async () => {
      capture = await createOutputCapture({
        removeDirectory: async () => {
          await rm(capture.path, { force: true });
          events.push("output-unlinked");
          throw new Error("partial removal failed");
        },
      });
      return capture;
    },
    spawnImpl: fakeChild((fd) => writeSync(fd, content)),
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; events.push("replay"); } },
  }), /partial removal failed/);
  assert.equal(stdout, "");
  assert.match(stderr, /^first real diagnostic\nlast real diagnostic\n/);
  assert.deepEqual(events, ["output-unlinked", "replay"]);
  await assert.rejects(access(capture.path));
});

test("descriptor cleanup attempts spool removal even when close reports failure", async () => {
  const capture = await createOutputCapture({ closeHandle: async (handle) => { await handle.close(); throw new Error("close failure"); } });
  writeSync(capture.fd, "diagnostics\n");
  await assert.rejects(capture.cleanup(), /close failure/);
  await assert.rejects(access(capture.path));
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
  const invocation = await mkdtemp(path.join(tmpdir(), "dev-loops-tmp-probe-"));
  const token = path.basename(invocation);
  const stale = [path.join("tmp/worktrees", token), path.join("tmp/copilot-loop", token)];
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
    await Promise.all([...stale.map((namespace) => rm(path.join(root, namespace), { recursive: true, force: true })), rm(invocation, { recursive: true, force: true })]);
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
