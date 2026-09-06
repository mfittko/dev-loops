import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeSync } from "node:fs";
import { access, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
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
  for (const reporter of [["--dots"], ["--reporter=dots"], ["--reporter", "dots"]]) {
    const args = buildBunTestArgs(["--only-failures", ...reporter, "example.test.mjs"], {});
    assert.equal(args.filter((arg) => arg === "--dots").length, 1);
    assert.ok(!args.includes("--only-failures"));
    assert.equal(args.filter((arg) => arg === "--path-ignore-patterns=tmp/**").length, 1);
  }
});

test("Bun summaries require a consistent terminal reporter block", () => {
  const summary = parseBunSummary("passing child says:\nnpm notice noisy tarball\n{\"heartbeat\":true}\n\n 2 pass\n 1 skip\n 0 fail\nRan 3 tests across 2 files. [123.00ms]\n");
  assert.equal(summary, "bun test: 2 pass, 1 skip, 0 fail across 2 files (123.00ms)\n");
  assert.equal(parseBunSummary("not a Bun summary\n"), null);
  assert.equal(parseBunSummary(" 2 pass\n 1 skip\n 0 fail\nRan 4 tests across 2 files. [123.00ms]\n"), null);
  assert.equal(parseBunSummary(` 0 pass\n ${"9".repeat(400)} fail\nRan ${"9".repeat(400)} tests across 1 file. [1.00ms]\n`), null);
  assert.equal(parseBunSummary(" 2 pass\n 0 fail\nRan 2 tests across 1 file. [1.00ms]\nlate exit-handler output\n 9 pass\n 0 fail\nRan 9 tests across 9 files. [9.00ms]\nspoof trailer\n"), null);
});

test("a zero exit with reported test failures fails closed", async () => {
  let stderr = "";
  await assert.rejects(
    runBunTest(["example.test.mjs"], {
      captureFactory: async () => memoryCapture(" 0 pass\n 1 fail\nRan 1 test across 1 file. [4.00ms]\n", []),
      spawnImpl: fakeChild(() => {}),
      stdout: { write() {} },
      stderr: { write: (chunk) => { stderr += chunk; } },
    }),
    /reported 1 failed test despite exiting successfully/,
  );
  assert.match(stderr, /1 fail/);
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

test("successful wrapper runs remove their real diagnostic spool", async () => {
  let capture;
  const code = await runBunTest(["example.test.mjs"], {
    captureFactory: async () => {
      capture = await createOutputCapture();
      return capture;
    },
    spawnImpl: fakeChild((fd) => writeSync(fd, " 1 pass\n 0 fail\nRan 1 test across 1 file. [1.00ms]\n")),
    stdout: { write() {} },
    stderr: { write() {} },
  });
  assert.equal(code, 0);
  await assert.rejects(access(capture.path));
});

test("dots stays observable while passing fixture chatter remains captured", async () => {
  for (const reporter of [["--dots"], ["--reporter=dots"], ["--reporter", "dots"]]) {
    const events = [];
    let childArgs;
    let stdout = "";
    let stderr = "";
    const timers = fakeIntervals();
    const content = "passing fixture chatter\n 1 pass\n 0 fail\nRan 1 test across 1 file. [4.00ms]\n";
    const code = await runBunTest([...reporter, "example.test.mjs"], {
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
  }
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

test("ordinary failures emit a focused digest and retain complete raw diagnostics", async () => {
  let capture;
  let stdout = "";
  let stderr = "";
  const content = [
    "bun test v1.4.1",
    "",
    "test/passing-fixture.test.mjs:",
    "UNRELATED PASSING FIXTURE CHATTER",
    "(pass) expected noisy fixture",
    "",
    "packages/core/test/default-branch-guard.test.mjs:",
    "SAME-FILE PASSING FIXTURE CHATTER",
    "(pass) another expected noisy fixture",
    "",
    "killed 1 dangling process",
    "41 | await neverSettles();",
    "              ^",
    "error: assertion context",
    "(fail) rejects default branch writes [5000.00ms]",
    "^ this test timed out after 5000ms.",
    "# Unhandled error between tests",
    "error: descendant server failed with EADDRINUSE",
    "",
    "1 pass",
    "1 fail",
    "Ran 2 tests across 2 files. [5.01s]",
    "",
  ].join("\n");
  try {
    const code = await runBunTest(["example.test.mjs"], {
      captureFactory: async () => {
        capture = await createOutputCapture();
        return capture;
      },
      spawnImpl: fakeChild((fd) => writeSync(fd, content), [7, null]),
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } },
    });
    assert.equal(code, 7);
    assert.equal(stdout, "");
    assert.doesNotMatch(stderr, /PASSING FIXTURE CHATTER|expected noisy fixture/);
    assert.match(stderr, /packages\/core\/test\/default-branch-guard\.test\.mjs:/);
    assert.match(stderr, /killed 1 dangling process/);
    assert.match(stderr, /\(fail\) rejects default branch writes \[5000\.00ms\]/);
    assert.match(stderr, /test timed out after 5000ms/);
    assert.match(stderr, /# Unhandled error between tests/);
    assert.match(stderr, /EADDRINUSE/);
    assert.match(stderr, /bun test: 1 pass, 0 skip, 1 fail across 2 files \(5\.01s\)/);
    assert.equal(stderr.match(/bun test: 1 pass, 0 skip, 1 fail/g)?.length, 1);
    assert.match(stderr, new RegExp(`Retained Bun diagnostics:\n${capture.path.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}\n`));
    assert.match(stderr, /Inspect the retained file with a pager\./);
    assert.equal(await readFile(capture.path, "utf8"), content);
  } finally {
    if (capture) await rm(path.dirname(capture.path), { recursive: true, force: true });
  }
});

test("failure digest caps multi-megabyte lines while retaining the complete raw line", async () => {
  let capture;
  let stderr = "";
  const giantLine = "x".repeat(2 * 1024 * 1024);
  const content = `test/giant.test.mjs:\n${giantLine}\n(fail) giant assertion\n0 pass\n1 fail\nRan 1 test across 1 file. [1.00ms]\n`;
  try {
    const code = await runBunTest(["example.test.mjs"], {
      captureFactory: async () => {
        capture = await createOutputCapture();
        return capture;
      },
      spawnImpl: fakeChild((fd) => writeSync(fd, content), [1, null]),
      stdout: { write() {} },
      stderr: { write: (chunk) => { stderr += chunk; } },
    });
    assert.equal(code, 1);
    assert.ok(Buffer.byteLength(stderr) < 40 * 1024);
    assert.match(stderr, /line truncated at 16384 bytes/);
    assert.match(stderr, /\(fail\) giant assertion/);
    assert.equal(await readFile(capture.path, "utf8"), content);
  } finally {
    if (capture) await rm(path.dirname(capture.path), { recursive: true, force: true });
  }
});

test("failure digest caps an unbroken sequence of short diagnostic lines", async () => {
  let capture;
  let stderr = "";
  const chatter = Array.from({ length: 20_000 }, (_, index) => `diagnostic ${index}`).join("\n");
  const content = `test/chatty.test.mjs:\n(fail) chatty assertion\n${chatter}\n0 pass\n1 fail\nRan 1 test across 1 file. [1.00ms]\n`;
  try {
    const code = await runBunTest(["example.test.mjs"], {
      captureFactory: async () => {
        capture = await createOutputCapture();
        return capture;
      },
      spawnImpl: fakeChild((fd) => writeSync(fd, content), [1, null]),
      stdout: { write() {} },
      stderr: { write: (chunk) => { stderr += chunk; } },
    });
    assert.equal(code, 1);
    assert.ok(Buffer.byteLength(stderr) < 140 * 1024);
    assert.match(stderr, /failure block truncated at 131072 bytes/);
    assert.equal(await readFile(capture.path, "utf8"), content);
  } finally {
    if (capture) await rm(path.dirname(capture.path), { recursive: true, force: true });
  }
});

test("nonzero and signaled runs preserve failure", async () => {
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
    assert.match(stderr, /first diagnostic\nlast diagnostic\n/);
    if (closeArgs[1]) assert.match(stderr, /SIGTERM/);
    assert.deepEqual(events, ["finish", "replay"]);
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
  assert.match(stderr, /child diagnostics\n/);
  assert.match(stderr, /closed without an exit code or signal/);
  assert.deepEqual(events, ["finish", "replay"]);
});

test("capture finalization failure retains its real tempfile for inspection", async () => {
  const events = [];
  let closeAttempts = 0;
  let capture;
  let stderr = "";
  try {
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
        stderr: { write: (chunk) => { stderr += chunk; events.push("digest"); } },
      }),
      /capture finalization failed/,
    );
    assert.match(stderr, /failed before a structured failure block/);
    assert.match(stderr, /Retained Bun diagnostics:/);
    assert.equal(await readFile(capture.path, "utf8"), "real tempfile diagnostics\n");
    assert.deepEqual(events, ["close-1", "digest", "digest", "digest", "close-2"]);
  } finally {
    if (capture) await rm(path.dirname(capture.path), { recursive: true, force: true });
  }
});

test("spawn and capture failures stay loud and retain captured failures", async () => {
  for (const failure of ["spawn", "summary", "replay"]) {
    const events = [];
    let stderr = "";
    const content = "complete diagnostics\n";
    const capture = memoryCapture(content, events, {
      summaryError: failure === "summary" ? new Error("tail read failed") : undefined,
      replayError: failure === "replay" ? new Error("replay failed") : undefined,
    });
    capture.path = "/tmp/dev-loops-test-retained.log";
    const spawnImpl = failure === "spawn"
      ? () => { const child = new EventEmitter(); queueMicrotask(() => child.emit("error", new Error("spawn denied"))); return child; }
      : fakeChild(() => {}, failure === "replay" ? [3, null] : [0, null]);
    await assert.rejects(
      runBunTest(["example.test.mjs"], { captureFactory: async () => capture, spawnImpl, stderr: { write: (chunk) => { stderr += chunk; } } }),
      new RegExp(failure === "spawn" ? "spawn denied" : failure === "summary" ? "tail read failed" : `${failure} failed`),
    );
    assert.ok(events.includes("replay"));
    assert.ok(!events.includes("cleanup"));
    if (["spawn", "summary"].includes(failure)) assert.match(stderr, /complete diagnostics/);
    assert.match(stderr, /Retained Bun diagnostics:/);
  }
});

test("cleanup errors retain a complete raw log before and after output unlink", async () => {
  const content = "first real diagnostic\nlast real diagnostic\n 1 pass\n 0 fail\nRan 1 test across 1 file. [4.00ms]\n";
  for (const unlinkOutput of [false, true]) {
    let capture;
    let stdout = "";
    let stderr = "";
    try {
      await assert.rejects(runBunTest(["example.test.mjs"], {
        captureFactory: async () => {
          capture = await createOutputCapture({
            removeDirectory: async () => {
              if (unlinkOutput) await rm(capture.path, { force: true });
              throw new Error("partial removal failed");
            },
          });
          return capture;
        },
        spawnImpl: fakeChild((fd) => writeSync(fd, content)),
        stdout: { write: (chunk) => { stdout += chunk; } },
        stderr: { write: (chunk) => { stderr += chunk; } },
      }), /partial removal failed/);
      assert.equal(stdout, "");
      assert.doesNotMatch(stderr, /first real diagnostic|last real diagnostic/);
      assert.match(stderr, /Retained Bun diagnostics:/);
      assert.equal(await readFile(capture.path, "utf8"), content);
    } finally {
      if (capture) await rm(path.dirname(capture.path), { recursive: true, force: true });
    }
  }
});

test("failed restoration keeps the byte-complete descriptor available for retry", async () => {
  let capture;
  const content = "first diagnostic\nlast diagnostic\n";
  try {
    capture = await createOutputCapture({
      removeDirectory: async (directory) => {
        await rm(directory, { recursive: true, force: true });
        await writeFile(directory, "temporarily blocks restoration");
        throw new Error("partial removal failed");
      },
    });
    writeSync(capture.fd, content);
    await assert.rejects(capture.cleanup(), /capture removal and restoration failed/);
    await rm(path.dirname(capture.path), { force: true });
    await capture.retain();
    assert.equal(await readFile(capture.path, "utf8"), content);
  } finally {
    if (capture) await rm(path.dirname(capture.path), { recursive: true, force: true });
  }
});

test("a pre-copy stat error retains the original spool without truncating its inode", async () => {
  let capture;
  const content = "first diagnostic\nlast diagnostic\n";
  try {
    capture = await createOutputCapture({
      removeDirectory: async () => { throw new Error("removal failed"); },
      statFile: async () => { const error = new Error("transient stat failure"); error.code = "EIO"; throw error; },
    });
    writeSync(capture.fd, content);
    await assert.rejects(capture.cleanup(), /capture removal and restoration failed/);
    await capture.retain();
    assert.equal(await readFile(capture.path, "utf8"), content);
  } finally {
    if (capture) await rm(path.dirname(capture.path), { recursive: true, force: true });
  }
});

test("restoration retry replaces a partial output file before closing the replay descriptor", async () => {
  let capture;
  let restoreAttempts = 0;
  const content = "first diagnostic\nlast diagnostic\n";
  try {
    capture = await createOutputCapture({
      removeDirectory: async () => {
        await rm(capture.path, { force: true });
        throw new Error("partial removal failed");
      },
      statFile: async () => { const error = new Error("missing"); error.code = "ENOENT"; throw error; },
      openRestoreFile: async (file) => {
        const writer = await open(file, "w");
        restoreAttempts += 1;
        if (restoreAttempts > 1) return writer;
        return {
          async write(buffer) {
            await writer.write(buffer.subarray(0, 5));
            throw new Error("mid-copy failure");
          },
          close: () => writer.close(),
        };
      },
    });
    writeSync(capture.fd, content);
    await assert.rejects(capture.cleanup(), /capture removal and restoration failed/);
    assert.equal(restoreAttempts, 1);
    await capture.retain();
    assert.equal(await readFile(capture.path, "utf8"), content);
  } finally {
    if (capture) await rm(path.dirname(capture.path), { recursive: true, force: true });
  }
});

test("descriptor cleanup attempts spool removal even when close reports failure", async () => {
  const capture = await createOutputCapture({ closeHandle: async (handle) => { await handle.close(); throw new Error("close failure"); } });
  writeSync(capture.fd, "diagnostics\n");
  await assert.rejects(capture.cleanup(), /close failure/);
  await assert.rejects(access(capture.path));
});

test("descriptor cleanup falls back to fd closure after the removed spool handle rejects", async () => {
  let fallbackFd;
  const capture = await createOutputCapture({
    closeReplayHandle: async (handle) => { await handle.close(); throw new Error("handle close failed"); },
    closeFileDescriptor: (fd) => { fallbackFd = fd; },
  });
  writeSync(capture.fd, "diagnostics\n");
  await capture.cleanup();
  assert.equal(fallbackFd >= 0, true);
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
