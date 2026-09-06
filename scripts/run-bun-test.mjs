#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const FAILURE_ONLY_FLAG = "--only-failures";
const DOTS_FLAG = "--dots";
const TMP_IGNORE_FLAG = "--path-ignore-patterns=tmp/**";
const SUCCESS_TAIL_BYTES = 64 * 1024;
const HEARTBEAT_MS = 15_000;
const TTY_REFRESH_MS = 250;
export const ALL_TEST_PATTERNS = Object.freeze([
  "test/**/*.test.mjs",
  "packages/core/test/*.test.mjs",
  "skills/dev-loop/scripts/*.test.mjs",
]);

export function resolveBunTestParallelism(env = process.env) {
  const raw = env.BUN_TEST_PARALLELISM;
  if (raw === undefined || raw === "") return 8;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("BUN_TEST_PARALLELISM must be a positive integer");
  return value;
}

export function buildBunTestArgs(args, env = process.env) {
  const callerArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === FAILURE_ONLY_FLAG || arg === TMP_IGNORE_FLAG) continue;
    if (arg === "--path-ignore-patterns" && args[index + 1] === "tmp/**") {
      index += 1;
      continue;
    }
    callerArgs.push(arg);
  }
  const reporting = callerArgs.includes(DOTS_FLAG) ? [] : [FAILURE_ONLY_FLAG];
  return ["test", ...reporting, TMP_IGNORE_FLAG, `--parallel=${resolveBunTestParallelism(env)}`, "--no-isolate", ...callerArgs];
}

export async function discoverRepositoryTests(repoRoot = DEFAULT_ROOT) {
  const files = (await Promise.all(ALL_TEST_PATTERNS.map((pattern) =>
    Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: repoRoot, onlyFiles: true }))))).flat().sort();
  const duplicate = files.find((file, index) => index > 0 && file === files[index - 1]);
  if (duplicate) throw new Error(`Duplicate Bun test inventory entry: ${duplicate}`);
  return files;
}

export async function resolveBunTestFiles(args, { discover = discoverRepositoryTests } = {}) {
  if (!args.includes("--all")) return args;
  if (args.filter((arg) => arg === "--all").length > 1) throw new Error("--all may be supplied only once");
  return [...args.filter((arg) => arg !== "--all"), ...await discover()];
}

export function childResult(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", (error) => finish({ code: 1, error, signal: undefined }));
    child.once("close", (code, signal) => finish(code === null && signal === null
      ? { code: 1, error: undefined, signal: undefined, abnormalTermination: true }
      : { code: code ?? 1, error: undefined, signal: signal ?? undefined }));
  });
}

export function parseBunSummary(output) {
  const plain = output.replaceAll(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trimEnd();
  const lines = plain.split("\n");
  const ranPattern = /^Ran (\d+) tests? across (\d+) files?\. \[([^\]]+)\]$/;
  if (lines.filter((line) => ranPattern.test(line.trim())).length !== 1) return null;
  const ran = lines.at(-1)?.trim().match(ranPattern);
  if (!ran) return null;

  const counts = new Map();
  let index = lines.length - 2;
  for (; index >= 0; index -= 1) {
    const match = lines[index].trim().match(/^(\d+) (pass|skip|fail|filtered out)$/);
    if (!match) break;
    if (counts.has(match[2])) return null;
    counts.set(match[2], Number(match[1]));
  }
  if (!counts.has("pass") || !counts.has("fail")) return null;
  const executed = (counts.get("pass") ?? 0) + (counts.get("skip") ?? 0) + (counts.get("fail") ?? 0);
  if (executed !== Number(ran[1])) return null;
  const files = Number(ran[2]);
  return `bun test: ${counts.get("pass")} pass, ${counts.get("skip") ?? 0} skip, ${counts.get("fail")} fail across ${files} ${files === 1 ? "file" : "files"} (${ran[3]})\n`;
}

export function createTestProgress({
  stream = process.stderr,
  dots = false,
  now = Date.now,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  let timer;
  let startedAt;
  let frame = 0;
  let renderedTTY = false;
  const elapsed = () => Math.max(0, Math.floor((now() - startedAt) / 1_000));
  const renderTTY = () => {
    const glyph = ["|", "/", "-", "\\"][frame % 4];
    frame += 1;
    renderedTTY = true;
    stream.write(`\rbun test ${glyph} running (${elapsed()}s)`);
  };
  return {
    start() {
      if (timer) return;
      startedAt = now();
      if (stream.isTTY) renderTTY();
      else if (dots) stream.write("bun test: running (--dots) (0s)\n");
      timer = setIntervalImpl(
        stream.isTTY ? renderTTY : () => stream.write(`bun test: still running (${elapsed()}s)\n`),
        stream.isTTY ? TTY_REFRESH_MS : HEARTBEAT_MS,
      );
      timer?.unref?.();
    },
    stop() {
      if (!timer) return;
      clearIntervalImpl(timer);
      timer = undefined;
      if (renderedTTY) stream.write("\r\x1b[2K");
    },
  };
}

export async function createOutputCapture({
  closeHandle = (value) => value.close(),
  removeDirectory = (directory) => rm(directory, { recursive: true, force: true }),
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "dev-loops-bun-test-"));
  const file = path.join(directory, "output.log");
  let handle;
  let replayHandle;
  try {
    handle = await open(file, "w+");
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const finish = async () => {
    if (!handle) return;
    const current = handle;
    await closeHandle(current);
    handle = undefined;
  };
  return {
    path: file,
    fd: handle.fd,
    finish,
    async readTail() {
      const { size } = await stat(file);
      const length = Math.min(size, SUCCESS_TAIL_BYTES);
      const reader = await open(file, "r");
      try {
        const buffer = Buffer.alloc(length);
        await reader.read(buffer, 0, length, size - length);
        return buffer.toString("utf8");
      } finally {
        await reader.close();
      }
    },
    async replay(stream) {
      const options = replayHandle
        ? { fd: replayHandle.fd, autoClose: false, start: 0, highWaterMark: 64 * 1024 }
        : { highWaterMark: 64 * 1024 };
      for await (const chunk of createReadStream(file, options)) {
        if (stream.write(chunk) === false) await once(stream, "drain");
      }
    },
    async cleanup() {
      let finishError;
      try { await finish(); }
      catch (error) { finishError = error; }
      if (!replayHandle) replayHandle = await open(file, "r");
      let removalError;
      try { await removeDirectory(directory); }
      catch (error) { removalError = error; }
      if (!removalError) {
        const current = replayHandle;
        await current.close();
        replayHandle = undefined;
      }
      if (finishError && removalError) throw new AggregateError([finishError, removalError], "Bun test capture close and removal failed");
      if (finishError) throw finishError;
      if (removalError) throw removalError;
    },
    async discard() {
      const errors = [];
      if (replayHandle) {
        const current = replayHandle;
        replayHandle = undefined;
        try { await current.close(); }
        catch (error) { errors.push(error); }
      }
      try { await finish(); }
      catch (error) { errors.push(error); }
      try { await rm(directory, { recursive: true, force: true }); }
      catch (error) { errors.push(error); }
      if (errors.length > 0) throw new AggregateError(errors, "Bun test capture disposal failed");
    },
  };
}

export async function runBunTest(args, {
  env = process.env, command = env.BUN_BIN || process.execPath, spawnImpl = spawn,
  stdout = process.stdout, stderr = process.stderr, captureFactory = createOutputCapture,
  progressFactory = createTestProgress,
} = {}) {
  let capture;
  let captureFinished = false;
  let diagnosticsReplayed = false;
  let result;
  let returnCode;
  let terminationMessage;
  let operationError;
  let cleanupError;
  let summary;
  const progress = progressFactory({ stream: stderr, dots: args.includes(DOTS_FLAG) });
  progress.start();
  try {
    capture = await captureFactory();
    const child = spawnImpl(command, buildBunTestArgs(await resolveBunTestFiles(args), env), {
      env, stdio: ["ignore", capture.fd, capture.fd],
    });
    result = await childResult(child);
  } catch (error) {
    operationError = error;
  } finally {
    progress.stop();
  }

  if (capture) {
    try {
      await capture.finish();
      captureFinished = true;
    } catch (finishError) {
      operationError = operationError
        ? new AggregateError([operationError, finishError], "Bun test execution and capture finalization failed")
        : new AggregateError([finishError], "Bun test capture finalization failed");
    }
  }

  if (result?.error) {
    operationError = operationError
      ? new AggregateError([operationError, result.error], "Bun test execution failed during capture finalization")
      : result.error;
  } else if (result?.abnormalTermination) {
    returnCode = 1;
    terminationMessage = "bun test closed without an exit code or signal\n";
  } else if (result?.signal) {
    returnCode = 1;
    terminationMessage = `bun test terminated by ${result.signal}\n`;
  } else if (result && result.code !== 0) {
    returnCode = result.code;
  } else if (result && captureFinished && !operationError) {
    try {
        summary = parseBunSummary(await capture.readTail());
        if (!summary) throw new Error("Could not parse Bun test summary from captured output");
        returnCode = 0;
    } catch (error) {
      operationError = error;
    }
  }

  if (capture && !diagnosticsReplayed && (operationError || returnCode !== 0)) {
    try {
      await capture.replay(stderr);
      diagnosticsReplayed = true;
    } catch (replayError) {
      operationError = operationError
        ? new AggregateError([operationError, replayError], `Bun test diagnostic replay failed: ${replayError.message}`)
        : replayError;
    }
  }
  if (terminationMessage) stderr.write(terminationMessage);

  if (capture) {
    try { await capture.cleanup(); }
    catch (error) { cleanupError = error; }
  }
  if (capture && cleanupError && !diagnosticsReplayed) {
    try {
      await capture.replay(stderr);
      diagnosticsReplayed = true;
    } catch (replayError) {
      cleanupError = new AggregateError([cleanupError, replayError], `Bun test capture cleanup and diagnostic replay failed: ${replayError.message}`);
    }
  }
  if (capture && cleanupError && capture.discard) {
    try { await capture.discard(); }
    catch (discardError) {
      cleanupError = new AggregateError([cleanupError, discardError], `Bun test capture cleanup and disposal failed: ${discardError.message}`);
    }
  }
  if (operationError && cleanupError) throw new AggregateError([operationError, cleanupError], `Bun test execution and capture cleanup failed: ${cleanupError.message}`);
  if (cleanupError) throw cleanupError;
  if (operationError) throw operationError;
  if (summary) stdout.write(summary);
  return returnCode;
}

if (import.meta.main) {
  try { process.exitCode = await runBunTest(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error?.message ?? error}\n`); process.exitCode = 1; }
}
