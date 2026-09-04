#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, mkdir, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MEASURED_REPETITIONS = 7;

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) result[argv[index]?.replace(/^--/, "")] = argv[index + 1];
  if (!result["npm-source"] || !result["bun-source"] || !result.output || !result.session || !result["power-state"] || !["npm", "bun"].includes(result.start)) throw new Error("usage: run-package-manager.mjs --npm-source <dir> --bun-source <dir> --session <id> --start <npm|bun> --power-state <description> --output <json>");
  return result;
}

function invoke(tool, args, { cwd, env, phase, measured }) {
  const started = process.hrtime.bigint();
  const result = spawnSync(tool, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { tool, args, phase, measured, durationMs: Number(process.hrtime.bigint() - started) / 1e6, exitCode: result.status ?? 1,
    signal: result.signal, stdout: result.stdout ?? "", stderr: result.stderr ?? String(result.error ?? "") };
}

export function buildPairOrders(startTool) {
  return Array.from({ length: MEASURED_REPETITIONS }, (_, pair) => {
    const first = pair % 2 === 0 ? startTool : startTool === "npm" ? "bun" : "npm";
    return [first, first === "npm" ? "bun" : "npm"];
  });
}

async function dependencyInventory(root) {
  const packages = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".bin") continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name.startsWith("@")) await walk(target);
      else if (entry.isDirectory()) try { const pkg = JSON.parse(await readFile(path.join(target, "package.json"), "utf8")); packages.push(`${pkg.name}@${pkg.version}`); } catch {}
    }
  }
  try { await walk(path.join(root, "node_modules")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const bins = [];
  try { bins.push(...await readdir(path.join(root, "node_modules", ".bin"))); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const workspaceLinks = [];
  for (const location of ["node_modules/@dev-loops/core"]) {
    const target = path.join(root, location);
    try { const stat = await lstat(target); workspaceLinks.push({ location, kind: stat.isSymbolicLink() ? "symlink" : "directory", target: stat.isSymbolicLink() ? await readlink(target) : null }); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  return { packages: packages.sort(), bins: bins.sort(), workspaceLinks };
}

async function copySource(source, destination) {
  const absoluteSource = path.resolve(source);
  await cp(absoluteSource, destination, { recursive: true, filter: (candidate) => {
    const relative = path.relative(absoluteSource, candidate);
    const first = relative.split(path.sep)[0];
    return !["node_modules", ".git", "tmp"].includes(first) && !/^docs\/benchmarks\/bun-1\.4\.1\/(?:session-.*\.raw\.json|verdict\.md)$/u.test(relative);
  } });
}

async function sourceFingerprint(root) {
  const hash = createHash("sha256");
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target);
      if (entry.isDirectory() && !["node_modules", ".git", "tmp"].includes(entry.name)) await walk(target);
      else if (entry.isFile() && !/^docs\/benchmarks\/bun-1\.4\.1\/(?:session-.*\.raw\.json|verdict\.md)$/u.test(relative)) files.push(relative);
    }
  }
  await walk(root);
  for (const file of files.sort()) hash.update(file).update(await readFile(path.join(root, file)));
  return hash.digest("hex");
}

async function reset(directory) { await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: true }); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `dev-loops-pm-${args.session}-`));
  try {
    const roots = { npm: path.join(tempRoot, "npm-project"), bun: path.join(tempRoot, "bun-project") };
    await Promise.all([copySource(args["npm-source"], roots.npm), copySource(args["bun-source"], roots.bun)]);
    const caches = { npm: path.join(tempRoot, "npm-cache"), bun: path.join(tempRoot, "bun-cache") };
    const envs = { npm: { ...process.env, npm_config_cache: caches.npm }, bun: { ...process.env, BUN_INSTALL_CACHE_DIR: caches.bun } };
    const commands = { npm: { install: ["ci"], verify: ["run", "verify"] }, bun: { install: ["install", "--frozen-lockfile"], verify: ["run", "verify"] } };
    const installs = { npm: {}, bun: {} };
    for (const tool of ["npm", "bun"]) {
      const nodeModules = path.join(roots[tool], "node_modules");
      const cold = { warmups: [], measured: [] };
      for (let iteration = 0; iteration <= MEASURED_REPETITIONS; iteration++) {
        await reset(caches[tool]); await rm(nodeModules, { recursive: true, force: true });
        const run = invoke(tool, commands[tool].install, { cwd: roots[tool], env: envs[tool], phase: "cold", measured: iteration > 0 });
        (iteration === 0 ? cold.warmups : cold.measured).push(run);
      }
      await reset(caches[tool]); await rm(nodeModules, { recursive: true, force: true });
      const warm = { prime: [invoke(tool, commands[tool].install, { cwd: roots[tool], env: envs[tool], phase: "warm-prime", measured: false })], warmups: [], measured: [] };
      for (let iteration = 0; iteration <= MEASURED_REPETITIONS; iteration++) {
        await rm(nodeModules, { recursive: true, force: true });
        const run = invoke(tool, commands[tool].install, { cwd: roots[tool], env: envs[tool], phase: "warm", measured: iteration > 0 });
        (iteration === 0 ? warm.warmups : warm.measured).push(run);
      }
      installs[tool] = { cold, warm };
    }
    const inventory = { npm: await dependencyInventory(roots.npm), bun: await dependencyInventory(roots.bun) };
    const verify = ["npm", "bun"].map((tool) => invoke(tool, commands[tool].verify, { cwd: roots[tool], env: envs[tool], phase: "verify-warmup", measured: false }));
    for (const order of buildPairOrders(args.start)) for (const tool of order) verify.push(invoke(tool, commands[tool].verify, { cwd: roots[tool], env: envs[tool], phase: "verify", measured: true }));
    const version = (tool) => spawnSync(tool, ["--version"], { encoding: "utf8" }).stdout.trim();
    const manifests = await Promise.all(Object.values(roots).map(async (root) => JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))));
    const evidence = { protocolVersion: 2, sessionId: args.session, sessionRoot: tempRoot, capturedAt: new Date().toISOString(), startTool: args.start,
      environment: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model ?? "unknown", node: process.version, bun: version("bun"), npm: version("npm"), powerState: args["power-state"] },
      sourceFingerprint: { npm: await sourceFingerprint(roots.npm), bun: await sourceFingerprint(roots.bun) }, suiteInventory: {
        npm: Object.keys(manifests[0].scripts).filter((name) => name.startsWith("test:")).sort(),
        bun: Object.keys(manifests[1].scripts).filter((name) => name.startsWith("test:")).sort(),
      },
      isolatedCaches: caches, inventory, installs, verify };
    await writeFile(path.resolve(args.output), `${JSON.stringify(evidence, null, 2)}\n`);
  } finally { await rm(tempRoot, { recursive: true, force: true }); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
