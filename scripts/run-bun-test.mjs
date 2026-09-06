#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, rm, stat } from "node:fs/promises";
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
const DIGEST_LINE_BYTES = 16 * 1024;
const DIGEST_CONTEXT_BYTES = 64 * 1024;
const DIGEST_FAILURE_BYTES = 128 * 1024;
const TRUNCATED_LINE = `… [line truncated at ${DIGEST_LINE_BYTES} bytes]`;
const TRUNCATED_FAILURE = `… [failure digest truncated at ${DIGEST_FAILURE_BYTES} bytes; complete output is retained]`;
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
    if (arg === "--reporter=dots" || (arg === "--reporter" && args[index + 1] === "dots")) {
      callerArgs.push(DOTS_FLAG);
      if (arg === "--reporter") index += 1;
      continue;
    }
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

function hasDotsReporter(args) {
  return args.some((arg, index) => arg === DOTS_FLAG || arg === "--reporter=dots" || (arg === "--reporter" && args[index + 1] === "dots"));
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
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value)) return null;
    counts.set(match[2], value);
  }
  if (!counts.has("pass") || !counts.has("fail")) return null;
  const executed = (counts.get("pass") ?? 0) + (counts.get("skip") ?? 0) + (counts.get("fail") ?? 0);
  const tests = Number(ran[1]);
  const files = Number(ran[2]);
  if (!Number.isSafeInteger(tests) || !Number.isSafeInteger(files) || executed !== tests) return null;
  return `bun test: ${counts.get("pass")} pass, ${counts.get("skip") ?? 0} skip, ${counts.get("fail")} fail across ${files} ${files === 1 ? "file" : "files"} (${ran[3]})\n`;
}

async function* boundedLines(input) {
  input.setEncoding("utf8");
  let line = "";
  let truncated = false;
  for await (const chunk of input) {
    let offset = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", offset);
      const fragment = chunk.slice(offset, newline < 0 ? undefined : newline);
      const remaining = DIGEST_LINE_BYTES - Buffer.byteLength(line);
      if (remaining > 0) line += Buffer.from(fragment).subarray(0, remaining).toString();
      if (Buffer.byteLength(fragment) > remaining) truncated = true;
      if (newline < 0) break;
      yield truncated ? `${line}${TRUNCATED_LINE}` : line;
      line = "";
      truncated = false;
      offset = newline + 1;
    }
  }
  if (line || truncated) yield truncated ? `${line}${TRUNCATED_LINE}` : line;
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
  closeReplayHandle = (value) => value.close(),
  closeFileDescriptor = closeSync,
  openRestoreFile = (file) => open(file, "w"),
  statFile = stat,
  removeDirectory = (directory) => rm(directory, { recursive: true, force: true }),
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "dev-loops-bun-test-"));
  const file = path.join(directory, "output.log");
  let handle;
  let replayHandle;
  let restorationPending = false;
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
  const replayStream = () => createReadStream(file, replayHandle
    ? { fd: replayHandle.fd, autoClose: false, start: 0, highWaterMark: 64 * 1024 }
    : { highWaterMark: 64 * 1024 });
  const write = async (stream, chunk) => {
    if (stream.write(chunk) === false) await once(stream, "drain");
  };
  const restoreReplay = async ({ force = false } = {}) => {
    if (!replayHandle) return;
    if (!force) {
      try {
        await statFile(file);
        return;
      } catch (error) {
        if (error.code !== "ENOENT") {
          if (error.code === "ENOTDIR") restorationPending = true;
          throw error;
        }
      }
    }
    restorationPending = true;
    await mkdir(directory, { recursive: true });
    const writer = await openRestoreFile(file);
    try {
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      for (;;) {
        const { bytesRead } = await replayHandle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await writer.write(chunk, offset, chunk.length - offset);
          if (bytesWritten === 0) throw new Error("Bun test capture restoration made no write progress");
          offset += bytesWritten;
        }
        position += bytesRead;
      }
    } finally {
      await writer.close();
    }
    restorationPending = false;
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
      for await (const chunk of replayStream()) await write(stream, chunk);
    },
    async writeFailureDigest(stream) {
      const headerPattern = /^(?:.*\/)?[^:\n]+\.test\.(?:mjs|js|ts|tsx|jsx):\s*$/;
      let header = null;
      let current = [];
      let currentBytes = 0;
      let previous = [];
      let paragraphHasStack = false;
      let emitting = false;
      let found = 0;
      let wroteHeader;
      let emittedBytes = 0;
      let failureTruncated = false;
      const writeFailureLine = async (line) => {
        if (failureTruncated) return;
        const chunk = `${line}\n`;
        const remaining = DIGEST_FAILURE_BYTES - emittedBytes;
        if (Buffer.byteLength(chunk) <= remaining) {
          await write(stream, chunk);
          emittedBytes += Buffer.byteLength(chunk);
          return;
        }
        await write(stream, `${TRUNCATED_FAILURE}\n`);
        failureTruncated = true;
      };
      const remember = (line) => {
        current.push(line);
        currentBytes += Buffer.byteLength(line) + 1;
        while (currentBytes > DIGEST_CONTEXT_BYTES && current.length > 1) {
          currentBytes -= Buffer.byteLength(current.shift()) + 1;
        }
      };
      const beginFailure = async () => {
        if (header !== wroteHeader) {
          await writeFailureLine(header ?? "Bun test failure:");
          wroteHeader = header;
        }
        for (const line of paragraphHasStack ? [...previous, ...current] : current) await writeFailureLine(line);
        current = [];
        currentBytes = 0;
        emitting = true;
        found += 1;
      };
      for await (const line of boundedLines(replayStream())) {
        if (headerPattern.test(line)) {
          header = line;
          current = [];
          currentBytes = 0;
          previous = [];
          paragraphHasStack = false;
          emitting = false;
          continue;
        }
        if (emitting && /^\d+ \|/.test(line)) {
          emitting = false;
          current = [];
          currentBytes = 0;
          previous = [];
          paragraphHasStack = false;
        }
        if (/^\s*\(fail\)\s/.test(line)) {
          await beginFailure();
          await writeFailureLine(line);
          continue;
        } else if (/^\s*# Unhandled error\b/.test(line)) {
          await beginFailure();
          await writeFailureLine(line);
          continue;
        }
        if (/^\s*\d+ (?:pass|skip|fail|filtered out)\s*$/.test(line)) {
          emitting = false;
          continue;
        }
        if (emitting) {
          if (line === "") emitting = false;
          else await writeFailureLine(line);
          continue;
        }
        if (line === "") {
          previous = current;
          current = [];
          currentBytes = 0;
          paragraphHasStack = false;
        } else {
          remember(line);
          if (/^\s+at\s/.test(line)) paragraphHasStack = true;
        }
      }
      if (found === 0) await write(stream, "bun test failed before a structured failure block was reported\n");
      const summary = parseBunSummary(await this.readTail());
      if (summary) await write(stream, summary);
    },
    async retain() {
      const errors = [];
      if (replayHandle) {
        const current = replayHandle;
        try {
          if (restorationPending) await restoreReplay({ force: true });
          restorationPending = false;
          await current.close();
          replayHandle = undefined;
        } catch (error) { errors.push(error); }
      }
      try { await finish(); }
      catch (error) { errors.push(error); }
      if (errors.length > 0) throw new AggregateError(errors, "Bun test capture retention failed");
    },
    async cleanup() {
      let finishError;
      try { await finish(); }
      catch (error) { finishError = error; }
      if (!replayHandle) replayHandle = await open(file, "r");
      let removalError;
      try { await removeDirectory(directory); }
      catch (error) { removalError = error; }
      if (removalError) {
        try { await restoreReplay(); }
        catch (restoreError) {
          removalError = new AggregateError([removalError, restoreError], "Bun test capture removal and restoration failed");
        }
      }
      if (!removalError) {
        const current = replayHandle;
        const descriptor = current.fd;
        try {
          await closeReplayHandle(current);
          replayHandle = undefined;
        } catch (error) {
          try {
            closeFileDescriptor(descriptor);
            replayHandle = undefined;
          }
          catch (fallbackError) {
            if (fallbackError.code === "EBADF") replayHandle = undefined;
            else {
              restorationPending = true;
              throw new AggregateError([error, fallbackError], "Bun test capture descriptor cleanup failed");
            }
          }
        }
      }
      if (finishError && removalError) throw new AggregateError([finishError, removalError], "Bun test capture close and removal failed");
      if (finishError) throw finishError;
      if (removalError) throw removalError;
    },
  };
}

async function finalizeCaptureOutcome(capture, { failed, stderr }) {
  let finalError;
  if (!failed) {
    try {
      await capture.cleanup();
      return undefined;
    } catch (error) {
      finalError = error;
    }
  }
  try {
    if (capture.writeFailureDigest) await capture.writeFailureDigest(stderr);
    else await capture.replay(stderr);
  } catch (digestError) {
    finalError = finalError
      ? new AggregateError([finalError, digestError], `Bun test failure finalization failed: ${digestError.message}`)
      : digestError;
  }
  if (capture.path) {
    stderr.write(`Retained Bun diagnostics:\n${capture.path}\n`);
    stderr.write("Inspect the retained file with a pager.\n");
  }
  if (capture.retain) {
    try { await capture.retain(); }
    catch (retainError) {
      finalError = finalError
        ? new AggregateError([finalError, retainError], `Bun test capture retention failed: ${retainError.message}`)
        : retainError;
    }
  }
  return finalError;
}

export async function runBunTest(args, {
  env = process.env, command = env.BUN_BIN || process.execPath, spawnImpl = spawn,
  stdout = process.stdout, stderr = process.stderr, captureFactory = createOutputCapture,
  progressFactory = createTestProgress,
} = {}) {
  let capture;
  let captureFinished = false;
  let result;
  let returnCode;
  let terminationMessage;
  let operationError;
  let summary;
  const progress = progressFactory({ stream: stderr, dots: hasDotsReporter(args) });
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
        const failedCount = Number(summary.match(/, (\d+) fail across/)?.[1] ?? 0);
        if (failedCount > 0) throw new Error(`Bun reported ${failedCount} failed ${failedCount === 1 ? "test" : "tests"} despite exiting successfully`);
        returnCode = 0;
    } catch (error) {
      operationError = error;
    }
  }

  const failed = Boolean(operationError || returnCode !== 0);
  if (terminationMessage) stderr.write(terminationMessage);
  const finalizationError = capture ? await finalizeCaptureOutcome(capture, { failed, stderr }) : undefined;
  if (operationError && finalizationError) throw new AggregateError([operationError, finalizationError], `Bun test execution and capture finalization failed: ${finalizationError.message}`);
  if (finalizationError) throw finalizationError;
  if (operationError) throw operationError;
  if (summary) stdout.write(summary);
  return returnCode;
}

if (import.meta.main) {
  try { process.exitCode = await runBunTest(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error?.message ?? error}\n`); process.exitCode = 1; }
}
