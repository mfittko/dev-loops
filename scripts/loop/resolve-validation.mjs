#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { parsePrNumber } from "../_cli-primitives.mjs";
import { isDirectCliRun } from "../_core-helpers.mjs";
import { normalizeGate, normalizeHeadSha } from "../github/_gate-names.mjs";
import { buildValidationResultsPath } from "../github/write-gate-context.mjs";
import { JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { buildValidationArtifact, classifyPackageSuites, parseRunGateValidationCliArgs, readPackageScripts } from "./run-gate-validation.mjs";
import { resolveRepoRoot } from "./_repo-root-resolver.mjs";

const USAGE = `Usage: dev-loops gate resolve-validation --profile <targeted|full-repository> --repo <owner/name> --pr <number> --gate <gate> --head-sha <full SHA> [--suite <script>]... [--tmp-root <dir>]\nTargeted profile requires at least one explicit --suite.\n${JQ_OUTPUT_USAGE}`;

async function removeParseFailedArtifact(argv) {
  const identity = {};
  for (let i = 0; i < argv.length; i++) {
    const match = /^--(repo|pr|gate|head-sha|tmp-root)(?:=(.*))?$/.exec(argv[i]);
    if (!match) continue;
    const name = match[1];
    identity[name] = match[2] ?? argv[++i];
  }
  if (!["repo", "pr", "gate", "head-sha"].every((name) => identity[name])) return;
  try {
    const artifactPath = buildValidationResultsPath({
      repo: identity.repo.trim(), pr: parsePrNumber(identity.pr), gate: normalizeGate(identity.gate),
      headSha: normalizeHeadSha(identity["head-sha"]), tmpRoot: identity["tmp-root"]?.trim() ?? "tmp",
    });
    const repoRoot = resolveRepoRoot(process.cwd());
    const absolutePath = path.resolve(repoRoot, artifactPath);
    const relativePath = path.relative(repoRoot, absolutePath);
    if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) return;
    const realRelativePath = path.relative(await realpath(repoRoot), await realpath(path.dirname(absolutePath)));
    if (realRelativePath === ".." || realRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(realRelativePath)) return;
    await rm(absolutePath, { force: true });
  } catch { /* Invalid identity has no trustworthy keyed artifact to remove. */ }
}

export function parseResolveValidationArgs(argv) {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const indices = args.flatMap((arg, index) => arg === "--profile" ? [index] : []);
  if (indices.length !== 1 || !args[indices[0] + 1]) throw new Error("exactly one --profile is required");
  const profile = args[indices[0] + 1];
  if (!["targeted", "full-repository"].includes(profile)) throw new Error("--profile must be targeted or full-repository");
  args.splice(indices[0], 2);
  const hasSuite = args.some((arg) => arg === "--suite" || arg.startsWith("--suite="));
  if (profile === "targeted" && !hasSuite) throw new Error("targeted profile requires an explicit --suite");
  if (profile === "full-repository" && !hasSuite) args.push("--suite", "verify");
  const options = parseRunGateValidationCliArgs(args);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(options.headSha)) throw new Error("--head-sha must be a full 40- or 64-character SHA");
  if (profile === "full-repository" && options.suites.join(",") !== "verify") {
    throw new Error("full-repository profile requires the single verify suite");
  }
  return { ...options, profile };
}

export async function resolveValidation(options, { repoRoot = resolveRepoRoot(process.cwd()), env = process.env } = {}) {
  const artifactPath = path.resolve(repoRoot, buildValidationResultsPath(options));
  // An incomplete outcome replaces any earlier same-head evidence with a typed
  // incomplete record, so the verdict writer sees that the round resolved its
  // validation and every reader sees `allPassed: false`. The old file goes
  // first: a failed write leaves the artifact absent, never a stale pass.
  // A tree whose HEAD is not the requested head gets no artifact at all: the
  // run is in the wrong checkout, so the verdict writer must see it as absent.
  const incomplete = async (reason, { writeArtifact = true } = {}) => {
    await rm(artifactPath, { force: true });
    if (!writeArtifact) {
      return { ok: false, status: "incomplete", profile: options.profile, headSha: options.headSha, toolchain: null, reason };
    }
    const artifact = {
      ok: false, status: "incomplete", allPassed: false,
      repo: options.repo, pr: options.pr, gate: options.gate, headSha: options.headSha,
      profile: options.profile, reason, generatedAt: new Date().toISOString(), suites: [],
    };
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    return { ok: false, status: "incomplete", profile: options.profile, headSha: options.headSha, toolchain: null, reason, artifactPath: buildValidationResultsPath(options) };
  };
  // An exception writes a typed artifact only when the head check confirmed
  // the requested head and a re-check at the throw still confirms it: a suite
  // may have moved HEAD before a later step threw.
  const gitEnv = { ...env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };
  const readHead = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", env: gitEnv }).trim().toLowerCase();
  let headConfirmed = false;
  try {
    const currentTreeProblem = () => {
      headConfirmed = false;
      const actualHead = readHead();
      headConfirmed = actualHead === options.headSha;
      if (!headConfirmed) return { reason: `worktree HEAD ${actualHead} differs from requested head`, writeArtifact: false };
      const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8", env: gitEnv }).trim();
      return dirty ? { reason: "validation requires a clean worktree at the requested head", writeArtifact: true } : null;
    };
    const beforeProblem = currentTreeProblem();
    if (beforeProblem) return incomplete(beforeProblem.reason, beforeProblem);
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
    const pinned = packageJson.packageManager;
    if (!/^bun@\d+\.\d+\.\d+$/.test(pinned ?? "")) return incomplete("packageManager does not pin an exact Bun version");
    const installed = execFileSync("bun", ["--version"], { cwd: repoRoot, encoding: "utf8", env }).trim();
    if (`bun@${installed}` !== pinned) return incomplete(`installed bun@${installed} differs from ${pinned}`);
    const scripts = await readPackageScripts(repoRoot);
    const classification = classifyPackageSuites(options.suites, scripts);
    if (options.profile === "targeted" && classification === "full-repository") return incomplete("targeted profile cannot run full-repository validation");
    if (options.profile === "targeted" && classification !== "targeted") return incomplete("targeted profile requires a validation suite");
    if (options.profile === "full-repository" && classification !== "full-repository") return incomplete("verify script is not classified as full-repository validation");
    const artifact = { ...await buildValidationArtifact(options, { repoRoot }), profile: options.profile, toolchain: pinned };
    const afterProblem = currentTreeProblem();
    if (afterProblem) return incomplete(`validation changed the worktree: ${afterProblem.reason}`, afterProblem);
    await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    return { ok: artifact.allPassed, status: artifact.allPassed ? "complete" : "failed", profile: options.profile, headSha: options.headSha, toolchain: pinned, artifactPath: buildValidationResultsPath(options), artifact };
  } catch (error) {
    let stillConfirmed = false;
    try { stillConfirmed = headConfirmed && readHead() === options.headSha; } catch { /* An unconfirmable head writes no artifact. */ }
    return incomplete(error instanceof Error ? error.message : String(error), { writeArtifact: stillConfirmed });
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
    if (!options) await removeParseFailedArtifact(argv);
    result = { ok: false, status: "incomplete", profile: null, headSha: null, toolchain: null, reason: error instanceof Error ? error.message : String(error) };
  }
  const emitted = emitResult(result, { jq: options?.jq, silent: options?.silent });
  process.exitCode = emitted === 2 ? 2 : result.ok ? 0 : 1;
}

if (isDirectCliRun(import.meta.url)) await main();
