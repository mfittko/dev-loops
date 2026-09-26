#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { classifyValidationCommand } from "@dev-loops/core/loop/validation-classify";
import { isDirectCliRun } from "../_core-helpers.mjs";
import { buildValidationResultsPath } from "../github/write-gate-context.mjs";
import { JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { buildValidationArtifact, parseRunGateValidationCliArgs, readPackageScripts, validateSuiteNames } from "./run-gate-validation.mjs";
import { resolveRepoRoot } from "./_repo-root-resolver.mjs";

const USAGE = `Usage: dev-loops gate resolve-validation --profile <targeted|full-repository> --repo <owner/name> --pr <number> --gate <gate> --head-sha <full SHA> [--suite <script>]...\n${JQ_OUTPUT_USAGE}`;

export function parseResolveValidationArgs(argv) {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const indices = args.flatMap((arg, index) => arg === "--profile" ? [index] : []);
  if (indices.length !== 1 || !args[indices[0] + 1]) throw new Error("exactly one --profile is required");
  const profile = args[indices[0] + 1];
  if (!["targeted", "full-repository"].includes(profile)) throw new Error("--profile must be targeted or full-repository");
  args.splice(indices[0], 2);
  if (profile === "full-repository" && !args.includes("--suite")) args.push("--suite", "verify");
  const options = parseRunGateValidationCliArgs(args);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(options.headSha)) throw new Error("--head-sha must be a full 40- or 64-character SHA");
  if (profile === "full-repository" && options.suites.join(",") !== "verify") {
    throw new Error("full-repository profile requires the single verify suite");
  }
  return { ...options, profile };
}

export async function resolveValidation(options, { repoRoot = resolveRepoRoot(process.cwd()), env = process.env } = {}) {
  const incomplete = (reason) => ({ ok: false, status: "incomplete", profile: options.profile, headSha: options.headSha, toolchain: null, reason });
  try {
    const actualHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", env: { ...env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } }).trim().toLowerCase();
    if (actualHead !== options.headSha) return incomplete(`worktree HEAD ${actualHead} differs from requested head`);
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
    const pinned = packageJson.packageManager;
    if (!/^bun@\d+\.\d+\.\d+$/.test(pinned ?? "")) return incomplete("packageManager does not pin an exact Bun version");
    const installed = execFileSync("bun", ["--version"], { cwd: repoRoot, encoding: "utf8", env }).trim();
    if (`bun@${installed}` !== pinned) return incomplete(`installed bun@${installed} differs from ${pinned}`);
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8", env: { ...env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } }).trim();
    if (dirty) return incomplete("validation requires a clean worktree at the requested head");
    const scripts = await readPackageScripts(repoRoot);
    validateSuiteNames(options.suites, scripts);
    const classification = classifyValidationCommand(options.suites.map((name) => `bun run ${name}`).join(" && "));
    if (options.profile === "targeted" && classification === "full-repository") return incomplete("targeted profile cannot run full-repository validation");
    if (options.profile === "targeted" && classification !== "targeted") return incomplete("targeted profile requires a validation suite");
    if (options.profile === "full-repository" && classification !== "full-repository") return incomplete("verify script is not classified as full-repository validation");
    const artifact = { ...await buildValidationArtifact(options, { repoRoot }), profile: options.profile, toolchain: pinned };
    const artifactPath = buildValidationResultsPath(options);
    await writeFile(path.resolve(repoRoot, artifactPath), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    return { ok: true, status: "complete", profile: options.profile, headSha: options.headSha, toolchain: pinned, artifactPath, artifact };
  } catch (error) {
    return incomplete(error instanceof Error ? error.message : String(error));
  }
}

export async function main(argv = process.argv.slice(2)) {
  let result;
  let options;
  try {
    options = parseResolveValidationArgs(argv);
    if (options.help) { process.stdout.write(`${USAGE}\n`); return; }
    result = await resolveValidation(options);
  } catch (error) {
    result = { ok: false, status: "incomplete", profile: null, headSha: null, toolchain: null, reason: error instanceof Error ? error.message : String(error) };
  }
  const emitted = emitResult(result, { jq: options?.jq, silent: options?.silent });
  process.exitCode = emitted === 2 ? 2 : result.ok ? 0 : 1;
}

if (isDirectCliRun(import.meta.url)) await main();
