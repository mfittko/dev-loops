#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, mkdir, readFile, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MEASURED_REPETITIONS = 7;
export const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60 * 1_000;

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) result[argv[index]?.replace(/^--/, "")] = argv[index + 1];
  if (!result["npm-source"] || !result["bun-source"] || !result.output || !result.session || !result["power-state"] || !["npm", "bun"].includes(result.start)) throw new Error("usage: run-package-manager.mjs --npm-source <dir> --bun-source <dir> --session <id> --start <npm|bun> --power-state <description> --output <json> [--timeout-ms <positive integer>]");
  const timeout = result["timeout-ms"] ?? String(DEFAULT_COMMAND_TIMEOUT_MS);
  if (!/^[1-9]\d*$/u.test(timeout) || !Number.isSafeInteger(Number(timeout))) throw new Error("--timeout-ms must be a positive integer");
  result.commandTimeoutMs = Number(timeout);
  return result;
}

const emitProgress = (event) => process.stderr.write(`[benchmark] ${JSON.stringify(event)}\n`);

export function invokeBenchmarkCommand(command, args, {
  cwd, env, sessionId, phase, tool = command, measured, sampleIndex, pairIndex, orderInPair, timeoutMs,
}, reportProgress = emitProgress) {
  const context = { sessionId, phase, tool, measured, sampleIndex, pairIndex, orderInPair, timeoutMs };
  reportProgress({ event: "command_start", ...context });
  const started = process.hrtime.bigint();
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs });
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  const timedOut = result.error?.code === "ETIMEDOUT";
  const run = { tool, args, phase, measured, sampleIndex, pairIndex, orderInPair, timeoutMs, timedOut, durationMs, exitCode: result.status ?? 1,
    signal: result.signal, errorCode: result.error?.code ?? null, stdout: result.stdout ?? "", stderr: result.stderr ?? String(result.error ?? "") };
  reportProgress({ event: "command_end", ...context, elapsedMs: durationMs, exitCode: run.exitCode, signal: run.signal, timedOut });
  return run;
}

export async function writeEvidenceAtomically(output, evidence) {
  const destination = path.resolve(output);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function buildPairOrders(startTool) {
  return Array.from({ length: MEASURED_REPETITIONS }, (_, pair) => {
    const first = pair % 2 === 0 ? startTool : startTool === "npm" ? "bun" : "npm";
    return [first, first === "npm" ? "bun" : "npm"];
  });
}

export function parseBunUntrustedPackages(output) {
  return [...String(output).matchAll(/^\.\/node_modules\/(.+?)\s+@[^\s]+$/gmu)]
    .map((match) => match[1])
    .sort();
}

export async function dependencyInventory(root) {
  const packages = new Set();
  const peerMetadata = new Map();
  const lifecycleScripts = new Map();
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".bin") continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name.startsWith("@")) await walk(target);
      else if (entry.isDirectory()) {
        try {
          const pkg = JSON.parse(await readFile(path.join(target, "package.json"), "utf8"));
          const identity = `${pkg.name}@${pkg.version}`;
          packages.add(identity);
          const peers = Object.entries(pkg.peerDependencies ?? {}).sort(([left], [right]) => left.localeCompare(right));
          const optionalPeers = Object.entries(pkg.peerDependenciesMeta ?? {})
            .filter(([, metadata]) => metadata?.optional === true)
            .map(([name]) => name)
            .sort();
          if (peers.length > 0 || optionalPeers.length > 0) peerMetadata.set(identity, { package: identity, peers, optionalPeers });
          const lifecycle = ["preinstall", "install", "postinstall"]
            .filter((name) => typeof pkg.scripts?.[name] === "string")
            .map((name) => [name, pkg.scripts[name]]);
          if (lifecycle.length > 0) lifecycleScripts.set(identity, { package: identity, scripts: lifecycle });
          await walk(path.join(target, "node_modules"));
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
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
  return {
    packages: [...packages].sort(),
    bins: bins.sort(),
    workspaceLinks,
    peerMetadata: [...peerMetadata.values()].sort((left, right) => left.package.localeCompare(right.package)),
    lifecycleScripts: [...lifecycleScripts.values()].sort((left, right) => left.package.localeCompare(right.package)),
  };
}

async function installLifecycleProbe(root) {
  const manifestPath = path.join(root, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.scripts ??= {};
  for (const phase of ["preinstall", "postinstall"]) {
    const probe = `node .benchmark-lifecycle-probe.cjs ${phase}`;
    manifest.scripts[phase] = manifest.scripts[phase] ? `${manifest.scripts[phase]} && ${probe}` : probe;
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(root, ".benchmark-lifecycle-probe.cjs"), [
    'const { mkdirSync, writeFileSync } = require("node:fs");',
    'mkdirSync(".benchmark-lifecycle", { recursive: true });',
    'writeFileSync(`.benchmark-lifecycle/${process.argv[2]}`, "completed\\n");',
    "",
  ].join("\n"));
}

async function copySource(source, destination) {
  const absoluteSource = path.resolve(source);
  await cp(absoluteSource, destination, { recursive: true, filter: (candidate) => {
    const relative = path.relative(absoluteSource, candidate);
    const first = relative.split(path.sep)[0];
    return !["node_modules", ".git", "tmp"].includes(first) && !/^docs\/benchmarks\/bun-1\.4\.1\/(?:session-.*\.raw\.json|verdict\.md)$/u.test(relative);
  } });
}

export function materializeGitRepository(root) {
  const identity = {
    GIT_AUTHOR_NAME: "dev-loops benchmark",
    GIT_AUTHOR_EMAIL: "benchmark@dev-loops.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "dev-loops benchmark",
    GIT_COMMITTER_EMAIL: "benchmark@dev-loops.invalid",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  const run = (args, env = process.env) => {
    const result = spawnSync("git", ["-C", root, ...args], { env, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  };
  run(["init", "--initial-branch=main"]);
  run(["add", "--all"]);
  run(["commit", "--no-gpg-sign", "-m", "benchmark source snapshot"], { ...process.env, ...identity });
  run(["remote", "add", "origin", "https://github.com/mfittko/dev-loops.git"]);
  run(["update-ref", "refs/remotes/origin/main", "HEAD"]);
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
    await Promise.all(Object.values(roots).map(installLifecycleProbe));
    for (const root of Object.values(roots)) materializeGitRepository(root);
    const caches = { npm: path.join(tempRoot, "npm-cache"), bun: path.join(tempRoot, "bun-cache") };
    const envs = { npm: { ...process.env, npm_config_cache: caches.npm }, bun: { ...process.env, BUN_INSTALL_CACHE_DIR: caches.bun } };
    const commands = { npm: { install: ["ci"], verify: ["run", "verify"] }, bun: { install: ["install", "--frozen-lockfile"], verify: ["run", "verify"] } };
    const invoke = (tool, commandArgs, details) => invokeBenchmarkCommand(tool, commandArgs, {
      cwd: roots[tool], env: envs[tool], sessionId: args.session, tool, timeoutMs: args.commandTimeoutMs, ...details,
    });
    const installs = { npm: {}, bun: {} };
    for (const tool of ["npm", "bun"]) {
      const nodeModules = path.join(roots[tool], "node_modules");
      const cold = { warmups: [], measured: [] };
      for (let iteration = 0; iteration <= MEASURED_REPETITIONS; iteration++) {
        await reset(caches[tool]); await rm(nodeModules, { recursive: true, force: true });
        const run = invoke(tool, commands[tool].install, { phase: "cold", measured: iteration > 0, sampleIndex: iteration });
        (iteration === 0 ? cold.warmups : cold.measured).push(run);
      }
      await reset(caches[tool]); await rm(nodeModules, { recursive: true, force: true });
      const warm = { prime: [invoke(tool, commands[tool].install, { phase: "warm-prime", measured: false, sampleIndex: 0 })], warmups: [], measured: [] };
      for (let iteration = 0; iteration <= MEASURED_REPETITIONS; iteration++) {
        await rm(nodeModules, { recursive: true, force: true });
        if (iteration === MEASURED_REPETITIONS) await rm(path.join(roots[tool], ".benchmark-lifecycle"), { recursive: true, force: true });
        const run = invoke(tool, commands[tool].install, { phase: "warm", measured: iteration > 0, sampleIndex: iteration });
        (iteration === 0 ? warm.warmups : warm.measured).push(run);
      }
      installs[tool] = { cold, warm };
    }
    const inventory = { npm: await dependencyInventory(roots.npm), bun: await dependencyInventory(roots.bun) };
    const lifecycleOutcomes = Object.fromEntries(await Promise.all(Object.entries(roots).map(async ([tool, root]) => [
      tool,
      (await readdir(path.join(root, ".benchmark-lifecycle")).catch(() => [])).sort(),
    ])));
    const bunLifecycleAudit = invoke("bun", ["pm", "untrusted"], { phase: "dependency-lifecycle-audit", measured: false, sampleIndex: 0 });
    const verify = ["npm", "bun"].map((tool, orderInPair) => invoke(tool, commands[tool].verify, { phase: "verify-warmup", measured: false, sampleIndex: 0, orderInPair }));
    for (const [pairIndex, order] of buildPairOrders(args.start).entries()) {
      for (const [orderInPair, tool] of order.entries()) verify.push(invoke(tool, commands[tool].verify, { phase: "verify", measured: true, sampleIndex: pairIndex + 1, pairIndex, orderInPair }));
    }
    const version = (tool) => spawnSync(tool, ["--version"], { encoding: "utf8" }).stdout.trim();
    const manifests = await Promise.all(Object.values(roots).map(async (root) => JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))));
    const evidence = { protocolVersion: 6, sessionId: args.session, sessionRoot: tempRoot, capturedAt: new Date().toISOString(), startTool: args.start, commandTimeoutMs: args.commandTimeoutMs,
      environment: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model ?? "unknown", node: process.version, bun: version("bun"), npm: version("npm"), powerState: args["power-state"] },
      sourceFingerprint: { npm: await sourceFingerprint(roots.npm), bun: await sourceFingerprint(roots.bun) }, suiteInventory: {
        npm: Object.keys(manifests[0].scripts).filter((name) => name.startsWith("test:")).sort(),
        bun: Object.keys(manifests[1].scripts).filter((name) => name.startsWith("test:")).sort(),
      },
      isolatedCaches: caches, inventory, lifecycleOutcomes,
      dependencyLifecycleAudit: {
        explicitlyTrusted: [...(manifests[1].trustedDependencies ?? [])].sort(),
        bun: bunLifecycleAudit,
        blockedPackages: parseBunUntrustedPackages(`${bunLifecycleAudit.stdout}\n${bunLifecycleAudit.stderr}`),
      },
      installs, verify };
    await writeEvidenceAtomically(args.output, evidence);
  } finally { await rm(tempRoot, { recursive: true, force: true }); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
