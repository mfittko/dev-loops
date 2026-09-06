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
const TMP_IGNORE_FLAG = "--path-ignore-patterns=tmp/**";
const SUCCESS_TAIL_BYTES = 64 * 1024;
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
  return ["test", FAILURE_ONLY_FLAG, TMP_IGNORE_FLAG, `--parallel=${resolveBunTestParallelism(env)}`, "--no-isolate", ...callerArgs];
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
  const plain = output.replaceAll(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const blocks = Array.from(plain.matchAll(/^\s*\d+ pass\s*\n(?:\s*\d+ [^\n]+\n)*Ran \d+ tests? across (\d+) files?\. \[([^\]]+)\]\s*$/gm));
  const block = blocks.at(-1);
  if (!block) return null;
  const pass = block[0].match(/^\s*(\d+) pass\s*$/m);
  const fail = block[0].match(/^\s*(\d+) fail\s*$/m);
  const skip = block[0].match(/^\s*(\d+) skip\s*$/m);
  if (!pass || !fail) return null;
  const files = Number(block[1]);
  return `bun test: ${pass[1]} pass, ${skip?.[1] ?? 0} skip, ${fail[1]} fail across ${files} ${files === 1 ? "file" : "files"} (${block[2]})\n`;
}

export async function createOutputCapture({ closeHandle = (value) => value.close() } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "dev-loops-bun-test-"));
  const file = path.join(directory, "output.log");
  let handle;
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
      for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
        if (stream.write(chunk) === false) await once(stream, "drain");
      }
    },
    async cleanup() {
      await finish();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function runBunTest(args, {
  env = process.env, command = env.BUN_BIN || process.execPath, spawnImpl = spawn,
  stdout = process.stdout, stderr = process.stderr, captureFactory = createOutputCapture,
} = {}) {
  let capture;
  let captureFinished = false;
  let diagnosticsReplayed = false;
  let result;
  let returnCode;
  let terminationMessage;
  let operationError;
  let cleanupError;
  try {
    capture = await captureFactory();
    const child = spawnImpl(command, buildBunTestArgs(await resolveBunTestFiles(args), env), {
      env, stdio: ["ignore", capture.fd, capture.fd],
    });
    result = await childResult(child);
  } catch (error) {
    operationError = error;
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
        const summary = parseBunSummary(await capture.readTail());
        if (!summary) throw new Error("Could not parse Bun test summary from captured output");
        stdout.write(summary);
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
  if (operationError && cleanupError) throw new AggregateError([operationError, cleanupError], `Bun test execution and capture cleanup failed: ${cleanupError.message}`);
  if (cleanupError) throw cleanupError;
  if (operationError) throw operationError;
  return returnCode;
}

if (import.meta.main) {
  try { process.exitCode = await runBunTest(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error?.message ?? error}\n`); process.exitCode = 1; }
}
