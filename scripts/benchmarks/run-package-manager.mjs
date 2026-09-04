#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) result[argv[index]?.replace(/^--/, "")] = argv[index + 1];
  if (!result["npm-source"] || !result["bun-source"] || !result.output) {
    throw new Error("usage: run-package-manager.mjs --npm-source <dir> --bun-source <dir> --output <json>");
  }
  return result;
}

function invoke(tool, args, { cwd, env, session, measured }) {
  const started = process.hrtime.bigint();
  const result = spawnSync(tool, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return {
    tool, args, session, measured,
    durationMs: Number(process.hrtime.bigint() - started) / 1e6,
    exitCode: result.status ?? 1,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? String(result.error ?? ""),
  };
}

async function inventory(root) {
  const found = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".bin") continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith("@")) await walk(target);
        else {
          try {
            const pkg = JSON.parse(await readFile(path.join(target, "package.json"), "utf8"));
            found.push(`${pkg.name}@${pkg.version}`);
          } catch {}
        }
      }
    }
  }
  try {
    await walk(path.join(root, "node_modules"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return found.sort();
}

async function copySource(source, destination) {
  const absoluteSource = path.resolve(source);
  await cp(absoluteSource, destination, {
    recursive: true,
    filter: (candidate) => {
      const relative = path.relative(absoluteSource, candidate);
      const first = relative.split(path.sep)[0];
      return !["node_modules", ".git", "tmp"].includes(first);
    },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pm-benchmark-"));
  try {
    const roots = { npm: path.join(tempRoot, "npm-project"), bun: path.join(tempRoot, "bun-project") };
    await Promise.all([copySource(args["npm-source"], roots.npm), copySource(args["bun-source"], roots.bun)]);
    const caches = { npm: path.join(tempRoot, "npm-cache"), bun: path.join(tempRoot, "bun-cache") };
    await Promise.all(Object.values(caches).map((directory) => mkdir(directory, { recursive: true })));
    const envs = {
      npm: { ...process.env, npm_config_cache: caches.npm },
      bun: { ...process.env, BUN_INSTALL_CACHE_DIR: caches.bun },
    };
    const commands = {
      npm: { install: ["ci"], verify: ["run", "verify"] },
      bun: { install: ["install", "--frozen-lockfile"], verify: ["run", "verify"] },
    };
    const installs = { npm: {}, bun: {} };
    for (const tool of ["npm", "bun"]) {
      installs[tool].cold = invoke(tool, commands[tool].install, { cwd: roots[tool], env: envs[tool], session: "install", measured: true });
      await rm(path.join(roots[tool], "node_modules"), { recursive: true, force: true });
      installs[tool].warm = invoke(tool, commands[tool].install, { cwd: roots[tool], env: envs[tool], session: "install", measured: true });
    }
    const inventories = { npm: await inventory(roots.npm), bun: await inventory(roots.bun) };
    const verify = [];
    for (const session of [1, 2]) {
      const order = session === 1 ? ["npm", "bun"] : ["bun", "npm"];
      for (let iteration = 0; iteration < 8; iteration++) {
        for (const tool of order) verify.push(invoke(tool, commands[tool].verify, { cwd: roots[tool], env: envs[tool], session, measured: iteration > 0 }));
      }
    }
    const version = (tool) => spawnSync(tool, ["--version"], { encoding: "utf8" }).stdout.trim();
    const evidence = {
      protocolVersion: 1,
      capturedAt: new Date().toISOString(),
      environment: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model ?? "unknown", node: process.version, bun: version("bun"), npm: version("npm") },
      sources: { npm: path.resolve(args["npm-source"]), bun: path.resolve(args["bun-source"]) },
      isolatedCaches: caches,
      inventory: inventories,
      installs,
      verify,
    };
    await writeFile(path.resolve(args.output), `${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
